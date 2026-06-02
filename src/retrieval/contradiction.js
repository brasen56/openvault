// @ts-check

/**
 * OpenVault Contradiction Detection
 *
 * Detects and resolves contradictory memories at retrieval time.
 * When two memories about the same character pair carry opposing sentiment
 * (e.g., "Alex is hostile to Ezra" vs "Alex and Ezra became close friends"),
 * the older memory is suppressed from injection.
 *
 * This is a keyword-based heuristic filter — fast, free, no LLM calls.
 * It handles clear-cut cases; nuanced contradictions should be handled
 * by a future LLM-based reconciliation layer.
 *
 * Algorithm:
 * 1. Group selected memories by overlapping character pairs
 * 2. For each group, classify sentiment (POSITIVE / NEGATIVE / NEUTRAL)
 * 3. If a group contains both POSITIVE and NEGATIVE memories,
 *    suppress the oldest ones of the minority sentiment
 * 4. The winning sentiment is the one backed by the most recent memory
 */

/** @typedef {import('../types').Memory} Memory */

import { SENTIMENT_POSITIVE, SENTIMENT_NEGATIVE, SENTIMENT_NEGATORS } from '../constants.js';
import { logDebug } from '../utils/logging.js';

/**
 * Sentiment classification result
 * @enum {string}
 */
export const Sentiment = {
    POSITIVE: 'positive',
    NEGATIVE: 'negative',
    NEUTRAL: 'neutral',
};

/**
 * Classify the sentiment of a memory summary towards a relationship.
 * Scans for positive/negative relationship keywords and returns the dominant
 * sentiment, or NEUTRAL if neither set matches or both match equally.
 *
 * @param {string} summary - Memory summary text
 * @returns {{sentiment: Sentiment, positiveCount: number, negativeCount: number}}
 */
export function classifySentiment(summary) {
    if (!summary || typeof summary !== 'string') {
        return { sentiment: Sentiment.NEUTRAL, positiveCount: 0, negativeCount: 0 };
    }

    const lower = summary.toLowerCase();
    // Ordered tokens (NOT a Set) so we can look back for a preceding negator.
    const tokens = lower.match(/[\p{L}0-9_]+/gu) || [];

    // A matched keyword is neutralized (dropped, not flipped) when a negator sits
    // within NEGATION_WINDOW tokens before it — e.g. "no longer hates", "не доверяет".
    // Dropping a wrong signal is safe; guessing the opposite polarity is not.
    const NEGATION_WINDOW = 3;
    const isNegated = (start) => {
        for (let i = Math.max(0, start - NEGATION_WINDOW); i < start; i++) {
            if (SENTIMENT_NEGATORS.has(tokens[i])) return true;
        }
        return false;
    };

    let positiveCount = 0;
    let negativeCount = 0;

    // Single-word matches — position-aware so negation can suppress them.
    for (let i = 0; i < tokens.length; i++) {
        if (isNegated(i)) continue;
        const t = tokens[i];
        if (SENTIMENT_POSITIVE.has(t)) positiveCount++;
        else if (SENTIMENT_NEGATIVE.has(t)) negativeCount++;
    }

    // Multi-word phrase matches (e.g. "made up", "fell out", "не доверяет").
    const positivePhrases = [...SENTIMENT_POSITIVE].filter((k) => k.includes(' '));
    const negativePhrases = [...SENTIMENT_NEGATIVE].filter((k) => k.includes(' '));
    for (const phrase of positivePhrases) {
        const at = phraseStartIndex(tokens, phrase);
        if (at >= 0 && !isNegated(at)) positiveCount++;
    }
    for (const phrase of negativePhrases) {
        const at = phraseStartIndex(tokens, phrase);
        if (at >= 0 && !isNegated(at)) negativeCount++;
    }

    // Determine dominant sentiment
    if (positiveCount > 0 && negativeCount === 0) {
        return { sentiment: Sentiment.POSITIVE, positiveCount, negativeCount };
    }
    if (negativeCount > 0 && positiveCount === 0) {
        return { sentiment: Sentiment.NEGATIVE, positiveCount, negativeCount };
    }
    // Both present or neither — treat as NEUTRAL (no clear signal)
    return { sentiment: Sentiment.NEUTRAL, positiveCount, negativeCount };
}

/**
 * Find the token index where a multi-word phrase begins, or -1 if absent.
 * Operates on the same tokenization as the caller so phrase boundaries line up
 * (and so a negator check can look at the tokens immediately before the phrase).
 *
 * @param {string[]} tokens - Lowercased token array of the summary
 * @param {string} phrase - Lowercased multi-word keyword (space-separated)
 * @returns {number} Start index of the phrase, or -1
 */
function phraseStartIndex(tokens, phrase) {
    const parts = phrase.split(/\s+/);
    for (let i = 0; i + parts.length <= tokens.length; i++) {
        let matched = true;
        for (let j = 0; j < parts.length; j++) {
            if (tokens[i + j] !== parts[j]) {
                matched = false;
                break;
            }
        }
        if (matched) return i;
    }
    return -1;
}

/**
 * Build a stable key for a set of character names (sorted, lowercased).
 * @param {string[]} names - Character names
 * @returns {string} Sorted, lowercased, pipe-delimited key
 */
function characterGroupKey(names) {
    return [...names]
        .map(n => n.toLowerCase().trim())
        .sort()
        .join('|');
}

/**
 * Get the recency ordering value for a memory.
 * Uses extraction_count (monotonic, survives chat compression) first,
 * then falls back to sequence, then created_at.
 *
 * @param {Memory} memory
 * @returns {number} Higher = more recent
 */
function getRecency(memory) {
    if (typeof memory.extraction_count === 'number') return memory.extraction_count;
    if (typeof memory.timestamp === 'number') return memory.timestamp;
    if (typeof memory.message_id === 'number') return memory.message_id;
    return 0;
}

/**
 * Detect contradictions in a set of selected memories and return
 * the IDs of older memories that should be suppressed.
 *
 * A contradiction occurs when two memories share the same character pair
 * (via `characters_involved`) and carry opposing sentiment. The older
 * memory (lower extraction_count/sequence) is suppressed.
 *
 * @param {Memory[]} memories - Selected memories to check for contradictions
 * @returns {{suppressedIds: string[], contradictions: Array<{newer: Memory, older: Memory, groupKey: string}>}}
 *   suppressedIds: IDs of memories to exclude from injection
 *   contradictions: Detail array for debug logging
 */
export function detectContradictions(memories) {
    if (!memories || memories.length <= 1) {
        return { suppressedIds: [], contradictions: [] };
    }

    // Step 1: Classify sentiment for each memory
    /** @type {Map<string, {sentiment: Sentiment}>} */
    const sentimentCache = new Map();
    for (const m of memories) {
        sentimentCache.set(m.id, classifySentiment(m.summary));
    }

    // Step 2: Group memories by character pair overlap
    // We look at `characters_involved` — if two memories share at least
    // 2 characters, they're in the same relationship group.
    // Also group single-character memories separately (they can't form pairs).
    /** @type {Map<string, Memory[]>} */
    const groups = new Map();

    for (const m of memories) {
        const chars = m.characters_involved || [];
        if (chars.length >= 2) {
            // Use the full character set as the group key
            const key = characterGroupKey(chars);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
    }

    // Step 3: Within each group, find contradictions
    const suppressedIds = new Set();
    const contradictions = [];

    for (const [groupKey, groupMemories] of groups) {
        if (groupMemories.length < 2) continue;

        // Separate into positive and negative sentiment buckets
        const positive = [];
        const negative = [];

        for (const m of groupMemories) {
            const { sentiment } = sentimentCache.get(m.id);
            if (sentiment === Sentiment.POSITIVE) positive.push(m);
            else if (sentiment === Sentiment.NEGATIVE) negative.push(m);
        }

        // Only process if we have both positive AND negative sentiments
        if (positive.length === 0 || negative.length === 0) continue;

        // Find the most recent memory in each sentiment bucket
        const mostRecentPositive = positive.reduce((a, b) => getRecency(a) > getRecency(b) ? a : b);
        const mostRecentNegative = negative.reduce((a, b) => getRecency(a) > getRecency(b) ? a : b);

        const positiveRecency = getRecency(mostRecentPositive);
        const negativeRecency = getRecency(mostRecentNegative);

        // Equal recency = we can't tell which sentiment is newer. This happens
        // whenever the opposing memories were extracted in the same batch (every
        // event in a batch shares one extraction_count — see extract.js). Suppressing
        // either side here would "retire" a memory that isn't actually older, so we
        // abstain and leave same-scene conflicts (e.g. "they argued then made up") to
        // the Tier 2 LLM resolver, which can read the narrative order.
        if (positiveRecency === negativeRecency) continue;

        // The winning sentiment is whichever has the most recent memory
        const positiveWins = positiveRecency > negativeRecency;

        // Suppress all memories of the losing sentiment in this group
        const losers = positiveWins ? negative : positive;
        const winner = positiveWins ? mostRecentPositive : mostRecentNegative;

        for (const loser of losers) {
            suppressedIds.add(loser.id);
            contradictions.push({
                newer: winner,
                older: loser,
                groupKey,
            });
        }
    }

    return {
        suppressedIds: Array.from(suppressedIds),
        contradictions,
    };
}

/**
 * Filter out contradictory memories from a selected set.
 * Convenience wrapper around detectContradictions that returns
 * the filtered array.
 *
 * @param {Memory[]} memories - Selected memories (already scored and budgeted)
 * @returns {Memory[]} Filtered memories with older contradictions removed
 */
export function filterContradictions(memories) {
    const { suppressedIds, contradictions } = detectContradictions(memories);

    if (contradictions.length > 0) {
        for (const c of contradictions) {
            logDebug(
                `Contradiction: suppressed older "${c.older.summary?.slice(0, 80)}" ` +
                `in favor of newer "${c.newer.summary?.slice(0, 80)}" ` +
                `(group: ${c.groupKey})`
            );
        }
    }

    return memories.filter(m => !suppressedIds.includes(m.id));
}