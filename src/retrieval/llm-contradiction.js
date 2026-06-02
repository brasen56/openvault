// @ts-check

/**
 * OpenVault LLM-Based Contradiction Resolution (Tier 2)
 *
 * Provides deep semantic contradiction detection and memory merging.
 * This module runs asynchronously OUTSIDE the hot retrieval path —
 * typically after extraction or during reflection cycles.
 *
 * Two-Tier Design:
 *   Tier 1 (Fast):  Keyword filter in contradiction.js → catches obvious cases
 *   Tier 2 (Deep):  LLM verifier in this file → catches subtle contradictions + merges
 *
 * @see future_feature_llm_contradiction.md
 */

/** @typedef {import('../types').Memory} Memory */

import { defaultSettings, extensionName } from '../constants.js';
import { getDeps } from '../deps.js';
import { enrichEventsWithEmbeddings } from '../embeddings.js';
import { parseContradictionVerificationResponse } from '../extraction/structured.js';
import { callLLM, LLM_CONFIGS } from '../llm.js';
import { record } from '../perf/store.js';
import { classifySentiment, Sentiment } from './contradiction.js';
import { tokenize } from './math.js';
import { logDebug, logError, logWarn } from '../utils/logging.js';

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt for contradiction verification.
 *
 * @param {Memory} memoryA - First memory
 * @param {Memory} memoryB - Second memory
 * @param {string[]} characterNames - Characters involved
 * @returns {Array<{role: string, content: string}>} Messages array for callLLM
 */
export function buildContradictionVerificationPrompt(memoryA, memoryB, characterNames) {
    const userMessage = `You are analyzing memories from a roleplay session. Determine whether these two memories about the same characters contradict each other.

CHARACTERS: ${characterNames.join(', ')}

MEMORY A (extracted at message ${memoryA.extraction_count ?? 0}):
"${memoryA.summary}"

MEMORY B (extracted at message ${memoryB.extraction_count ?? 0}):
"${memoryB.summary}"

Respond in JSON:
{
  "contradicts": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation",
  "newer_is_authoritative": true/false,
  "suggested_merge": null OR "merged summary that preserves both facts"
}

Rules:
- Two memories contradict ONLY if they describe the SAME relationship/fact in mutually exclusive ways.
- A relationship changing over time (enemies → friends) is NOT a contradiction — it is character development.
- Contradictions require the same timeframe describing opposite states of the same thing.
- If the memories describe events at different times, set contradicts=false and suggest a merge that preserves the narrative arc.
- Only suggest a merge when the memories truly conflict AND a combined summary would be more accurate.`;

    return [{ role: 'user', content: userMessage }];
}

// ---------------------------------------------------------------------------
// Core: LLM Contradiction Verification
// ---------------------------------------------------------------------------

/**
 * Use LLM to verify a potential contradiction flagged by Tier 1 keyword filter.
 *
 * @param {Memory} memoryA - First memory
 * @param {Memory} memoryB - Second memory
 * @param {string[]} characterNames - Characters involved
 * @param {Object} [options={}] - Options
 * @param {number} [options.confidenceThreshold=0.7] - Minimum confidence to confirm contradiction
 * @returns {Promise<{contradicts: boolean, confidence: number, merge: string|null, newerIsAuthoritative: boolean, reason: string}>}
 */
export async function verifyContradiction(memoryA, memoryB, characterNames, options = {}) {
    const { confidenceThreshold = 0.7 } = options;
    const t0 = performance.now();

    const messages = buildContradictionVerificationPrompt(memoryA, memoryB, characterNames);

    logDebug(
        `LLM contradiction check: comparing "${memoryA.summary?.slice(0, 60)}…" vs "${memoryB.summary?.slice(0, 60)}…"`
    );

    const response = await callLLM(messages, LLM_CONFIGS.contradiction, { structured: true });
    const parsed = parseContradictionVerificationResponse(response);

    const contradicts = parsed.contradicts && parsed.confidence >= confidenceThreshold;

    logDebug(
        `LLM contradiction check result: ${contradicts ? 'CONFLICT' : 'OK'} ` +
        `(confidence: ${parsed.confidence.toFixed(2)}, reason: ${parsed.reason?.slice(0, 80)})`
    );

    record('llm_contradiction', performance.now() - t0);

    return {
        contradicts,
        confidence: parsed.confidence,
        merge: parsed.suggested_merge || null,
        newerIsAuthoritative: parsed.newer_is_authoritative,
        reason: parsed.reason,
    };
}

// ---------------------------------------------------------------------------
// Memory Merging
// ---------------------------------------------------------------------------

/**
 * Merge two conflicting memories into one.
 * The older memory gets archived; the newer memory's summary is replaced
 * with the merged version.
 *
 * After merging, the caller should re-embed the newer memory via
 * `enrichEventsWithEmbeddings([newerMemory])` to update its vector.
 *
 * @param {Memory} olderMemory - The older memory (will be archived)
 * @param {Memory} newerMemory - The newer memory (will be updated)
 * @param {string} mergedSummary - The merged summary from LLM
 * @returns {{ archived: Memory, updated: Memory }} The modified memory objects
 */
export function mergeContradictingMemories(olderMemory, newerMemory, mergedSummary) {
    // Archive the older memory (soft delete)
    olderMemory.archived = true;
    /** @type {any} */ (olderMemory).archive_reason = 'contradiction_merge';
    /** @type {any} */ (olderMemory).merged_into = newerMemory.id;

    // Update the newer memory with the merged summary
    newerMemory.summary = mergedSummary;
    /** @type {any} */ (newerMemory).merge_sources = [olderMemory.id, newerMemory.id];
    /** @type {any} */ (newerMemory).merge_timestamp = getDeps().Date.now();

    // Preserve the higher importance
    newerMemory.importance = Math.max(olderMemory.importance || 3, newerMemory.importance || 3);

    // Merge token lists for BM25
    newerMemory.tokens = [...new Set([
        ...(olderMemory.tokens || []),
        ...(newerMemory.tokens || []),
        ...tokenize(mergedSummary),
    ])];

    logDebug(
        `Contradiction merge: archived "${olderMemory.summary?.slice(0, 60)}…" → ` +
        `updated to "${mergedSummary?.slice(0, 60)}…"`
    );

    return { archived: olderMemory, updated: newerMemory };
}

// ---------------------------------------------------------------------------
// Batch Scanning Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable key for a set of character names (sorted, lowercased).
 * @param {string[]} names - Character names
 * @returns {string} Sorted, lowercased, pipe-delimited key
 */
function characterGroupKey(names) {
    return [...names]
        .map((n) => n.toLowerCase().trim())
        .sort()
        .join('|');
}

/**
 * Group non-archived event memories by their character pair overlap.
 * Only memories with ≥2 characters are grouped (single-character memories
 * can't form relationship pairs).
 *
 * @param {Memory[]} memories - All memories to group
 * @returns {Map<string, Memory[]>} Character-pair key → memories
 */
export function groupMemoriesByCharacterPair(memories) {
    const groups = new Map();

    for (const m of memories) {
        if (m.archived || m.type === 'reflection') continue;
        const chars = m.characters_involved || [];
        if (chars.length < 2) continue;

        const key = characterGroupKey(chars);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
    }

    return groups;
}

/**
 * Find suspicious memory pairs within a group that are worth LLM verification.
 *
 * Criteria for "suspicious":
 * 1. Tier 1 flagged: different sentiment classification (POSITIVE vs NEGATIVE)
 * 2. Large extraction_count gap: memories span a wide range, suggesting
 *    the relationship may have evolved (worth checking for arc preservation)
 *
 * @param {Memory[]} memories - Memories for a single character pair
 * @param {number} [maxPairs=5] - Maximum pairs to return (cost control)
 * @returns {Array<[Memory, Memory]>} Pairs to check
 */
export function findSuspiciousPairs(memories, maxPairs = 5) {
    if (memories.length < 2) return [];

    /** @type {Array<[Memory, Memory]>} */
    const pairs = [];
    const seen = new Set();

    // Sort by recency for consistent pairing
    const sorted = [...memories].sort((a, b) => {
        const ra = a.extraction_count ?? a.timestamp ?? a.message_id ?? 0;
        const rb = b.extraction_count ?? b.timestamp ?? b.message_id ?? 0;
        return ra - rb;
    });

    // Strategy 1: Check for sentiment conflicts (Tier 1 flagged)
    for (let i = 0; i < sorted.length && pairs.length < maxPairs; i++) {
        const sentimentA = classifySentiment(sorted[i].summary);
        if (sentimentA.sentiment === Sentiment.NEUTRAL) continue;

        for (let j = i + 1; j < sorted.length && pairs.length < maxPairs; j++) {
            const sentimentB = classifySentiment(sorted[j].summary);
            if (sentimentB.sentiment === Sentiment.NEUTRAL) continue;

            // Different non-neutral sentiments → suspicious
            if (sentimentA.sentiment !== sentimentB.sentiment) {
                const key = `${sorted[i].id}|${sorted[j].id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    pairs.push([sorted[i], sorted[j]]);
                }
            }
        }
    }

    // Strategy 2: Large extraction_count gap pairs (relationship evolution)
    if (pairs.length < maxPairs && sorted.length >= 2) {
        const oldest = sorted[0];
        const newest = sorted[sorted.length - 1];
        const oldestCount = oldest.extraction_count ?? 0;
        const newestCount = newest.extraction_count ?? 0;

        // Only add if there's a significant gap (≥50 messages) and not already paired
        if (newestCount - oldestCount >= 50) {
            const key = `${oldest.id}|${newest.id}`;
            if (!seen.has(key)) {
                pairs.push([oldest, newest]);
            }
        }
    }

    return pairs;
}

// ---------------------------------------------------------------------------
// Batch Contradiction Scan
// ---------------------------------------------------------------------------

/**
 * Run a batch contradiction scan over all memories.
 *
 * Groups memories by character pairs, finds suspicious pairs within each
 * group, and uses the LLM to verify each pair. Confirmed contradictions
 * are optionally auto-merged.
 *
 * @param {Memory[]} allMemories - All active memories
 * @param {Object} [options={}] - Options
 * @param {number} [options.maxCalls=5] - Maximum LLM calls per scan (cost control)
 * @param {number} [options.confidenceThreshold=0.7] - Minimum confidence to act on
 * @param {boolean} [options.autoMerge=false] - Whether to auto-merge confirmed contradictions
 * @returns {Promise<Array<{older: string, newer: string, merged: boolean, reason: string}>>}
 *   Array of results with memory IDs and merge status
 */
export async function batchContradictionScan(allMemories, options = {}) {
    const {
        maxCalls = 5,
        confidenceThreshold = 0.7,
        autoMerge = false,
    } = options;

    const groups = groupMemoriesByCharacterPair(allMemories);

    let callsUsed = 0;
    const results = [];

    for (const [pairKey, groupMemories] of groups) {
        if (callsUsed >= maxCalls) break;
        if (groupMemories.length < 2) continue;

        const suspicious = findSuspiciousPairs(groupMemories, maxCalls - callsUsed);

        for (const [memA, memB] of suspicious) {
            if (callsUsed >= maxCalls) break;

            try {
                const charNames = [...new Set([
                    ...(memA.characters_involved || []),
                    ...(memB.characters_involved || []),
                ])];

                const result = await verifyContradiction(memA, memB, charNames, { confidenceThreshold });
                callsUsed++;

                if (result.contradicts) {
                    const older = getRecency(memA) < getRecency(memB) ? memA : memB;
                    const newer = older === memA ? memB : memA;

                    if (autoMerge && result.merge) {
                        mergeContradictingMemories(older, newer, result.merge);
                        // Re-embed the updated memory
                        await enrichEventsWithEmbeddings([newer]);
                    }

                    results.push({
                        older: older.id,
                        newer: newer.id,
                        merged: autoMerge && !!result.merge,
                        reason: result.reason,
                        confidence: result.confidence,
                    });
                }
            } catch (error) {
                logWarn(`LLM contradiction check failed for pair ${memA.id}/${memB.id}: ${error.message}`);
                callsUsed++;
            }
        }
    }

    if (results.length > 0) {
        logDebug(`Batch contradiction scan complete: ${results.length} contradictions found (${callsUsed} LLM calls used)`);
    }

    return results;
}

// ---------------------------------------------------------------------------
// Post-Extraction Verification Queue
// ---------------------------------------------------------------------------

/**
 * Check a newly extracted memory against existing memories for contradictions.
 * This is the entry point for the post-extraction hook.
 *
 * Only triggers LLM verification when:
 * 1. The feature is enabled (`llmContradictionEnabled`)
 * 2. Tier 1 keyword filter flagged at least one potential contradiction
 *
 * @param {Memory} newMemory - Newly extracted memory
 * @param {Memory[]} existingMemories - All existing active memories
 * @param {Object} [options={}] - Options
 * @param {number} [options.confidenceThreshold] - Override confidence threshold
 * @param {boolean} [options.autoMerge] - Override auto-merge setting
 * @returns {Promise<{verified: boolean, merged: boolean, reason?: string}>}
 *   Result of the verification
 */
export async function checkNewMemoryContradictions(newMemory, existingMemories, options = {}) {
    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const enabled = settings.llmContradictionEnabled ?? defaultSettings.llmContradictionEnabled;
    const confidenceThreshold = options.confidenceThreshold ?? settings.llmContradictionConfidence ?? defaultSettings.llmContradictionConfidence;
    const autoMerge = options.autoMerge ?? settings.llmContradictionAutoMerge ?? defaultSettings.llmContradictionAutoMerge;

    if (!enabled) {
        return { verified: false, merged: false };
    }

    const newChars = newMemory.characters_involved || [];
    if (newChars.length < 2) {
        return { verified: false, merged: false };
    }

    // Find existing memories that share characters with the new memory
    const newCharSet = new Set(newChars.map((c) => c.toLowerCase()));
    const overlappingMemories = existingMemories.filter((m) => {
        if (m.archived || m.type === 'reflection') return false;
        const mChars = m.characters_involved || [];
        if (mChars.length < 2) return false;
        return mChars.some((c) => newCharSet.has(c.toLowerCase()));
    });

    if (overlappingMemories.length === 0) {
        return { verified: false, merged: false };
    }

    // Tier 1 pre-filter: only check memories with opposing sentiment
    const newSentiment = classifySentiment(newMemory.summary);
    if (newSentiment.sentiment === Sentiment.NEUTRAL) {
        return { verified: false, merged: false };
    }

    const opposingMemories = overlappingMemories.filter((m) => {
        const mSentiment = classifySentiment(m.summary);
        return mSentiment.sentiment !== Sentiment.NEUTRAL && mSentiment.sentiment !== newSentiment.sentiment;
    });

    if (opposingMemories.length === 0) {
        return { verified: false, merged: false };
    }

    // Tier 2: LLM verification for each opposing memory (limit to 3 for cost)
    const toCheck = opposingMemories.slice(0, 3);

    for (const existing of toCheck) {
        try {
            const charNames = [...new Set([
                ...(newMemory.characters_involved || []),
                ...(existing.characters_involved || []),
            ])];

            const result = await verifyContradiction(newMemory, existing, charNames, { confidenceThreshold });

            if (result.contradicts) {
                const older = getRecency(newMemory) < getRecency(existing) ? newMemory : existing;
                const newer = older === newMemory ? existing : newMemory;

                if (autoMerge && result.merge) {
                    mergeContradictingMemories(older, newer, result.merge);
                    await enrichEventsWithEmbeddings([newer]);
                }

                return {
                    verified: true,
                    merged: autoMerge && !!result.merge,
                    reason: result.reason,
                };
            }
        } catch (error) {
            logWarn(`Post-extraction contradiction check failed: ${error.message}`);
            // Continue checking other pairs — don't let one failure stop the queue
        }
    }

    return { verified: true, merged: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the recency ordering value for a memory.
 * Uses extraction_count (monotonic) first, then falls back to timestamp/message_id.
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