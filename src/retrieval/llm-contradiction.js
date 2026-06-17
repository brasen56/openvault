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
import { callLLM, callOpenAICompat, LLM_CONFIGS } from '../llm.js';
import { record } from '../perf/store.js';
import { cyrb53, getEmbedding } from '../utils/embedding-codec.js';
import { logDebug, logWarn } from '../utils/logging.js';
import { classifySentiment, Sentiment } from './contradiction.js';
import { cosineSimilarity, tokenize } from './math.js';

/** Max entries kept in the persisted analyzed-pair cache (FIFO-trimmed). */
const MAX_ANALYZED_PAIRS = 5000;

/**
 * Stable cache key for a memory pair. Embeds a content hash of each summary so
 * the entry self-invalidates when either memory's text changes (edit/merge).
 * @param {Memory} memA
 * @param {Memory} memB
 * @returns {string}
 */
function analyzedPairKey(memA, memB) {
    const a = `${memA.id}:${cyrb53(memA.summary || '')}`;
    const b = `${memB.id}:${cyrb53(memB.summary || '')}`;
    return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * True if this exact pair (with unchanged summaries) was already analyzed.
 * @param {Object<string, number>|null|undefined} cache
 * @param {Memory} memA
 * @param {Memory} memB
 */
function isPairAnalyzed(cache, memA, memB) {
    return !!cache && cache[analyzedPairKey(memA, memB)] === 1;
}

/**
 * Record a pair as analyzed, trimming oldest entries past MAX_ANALYZED_PAIRS.
 * @param {Object<string, number>|null|undefined} cache
 * @param {Memory} memA
 * @param {Memory} memB
 */
function recordAnalyzedPair(cache, memA, memB) {
    if (!cache) return;
    cache[analyzedPairKey(memA, memB)] = 1;
    const keys = Object.keys(cache);
    if (keys.length > MAX_ANALYZED_PAIRS) {
        for (const k of keys.slice(0, keys.length - MAX_ANALYZED_PAIRS)) delete cache[k];
    }
}

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

    // Determine whether to use custom OpenAI-compatible API or Connection Manager profile
    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const useCustomApi = settings.llmContradictionUseCustomApi ?? defaultSettings.llmContradictionUseCustomApi;

    let response;
    if (useCustomApi) {
        const apiUrl = String(settings.llmContradictionApiUrl || '').trim();
        const apiKey = String(settings.llmContradictionApiKey || '').trim();
        const model = String(settings.llmContradictionApiModel || '').trim();

        if (!apiUrl || !model) {
            throw new Error('Contradiction Analysis: custom API enabled but URL or Model is not configured');
        }

        response = await callOpenAICompat(messages, {
            apiUrl,
            apiKey: apiKey || undefined,
            model,
            maxTokens: LLM_CONFIGS.contradiction.maxTokens,
            timeoutMs: LLM_CONFIGS.contradiction.timeoutMs,
            errorContext: 'Contradiction verification (custom API)',
        });
    } else {
        response = await callLLM(messages, LLM_CONFIGS.contradiction, { structured: true });
    }

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
 * After merging, the caller should:
 * 1. Re-embed the newer memory via `enrichEventsWithEmbeddings([newerMemory])`
 * 2. Push ST Vector sync changes (delete archived, re-sync updated)
 *
 * @param {Memory} olderMemory - The older memory (will be archived)
 * @param {Memory} newerMemory - The newer memory (will be updated)
 * @param {string} mergedSummary - The merged summary from LLM
 * @returns {{ archived: Memory, updated: Memory, olderPreMergeSummary: string, newerPreMergeSummary: string }}
 *   The modified memory objects plus pre-merge summaries for ST vector re-sync
 */
export function mergeContradictingMemories(olderMemory, newerMemory, mergedSummary) {
    // Save pre-merge summary for ST vector re-sync (hash is text-dependent)
    const olderPreMergeSummary = olderMemory.summary;
    const newerPreMergeSummary = newerMemory.summary;

    // Archive the older memory (soft delete)
    olderMemory.archived = true;
    olderMemory.archive_reason = 'contradiction_merge';
    olderMemory.merged_into = newerMemory.id;

    // Update the newer memory with the merged summary
    newerMemory.summary = mergedSummary;
    newerMemory.merge_sources = [olderMemory.id, newerMemory.id];
    newerMemory.merge_timestamp = getDeps().Date.now();

    // Preserve the higher importance
    newerMemory.importance = Math.max(olderMemory.importance || 3, newerMemory.importance || 3);

    // Merge token lists for BM25
    newerMemory.tokens = [
        ...new Set([...(olderMemory.tokens || []), ...(newerMemory.tokens || []), ...tokenize(mergedSummary)]),
    ];

    logDebug(
        `Contradiction merge: archived "${olderPreMergeSummary?.slice(0, 60)}…" → ` +
            `updated to "${mergedSummary?.slice(0, 60)}…"`
    );

    return { archived: olderMemory, updated: newerMemory, olderPreMergeSummary, newerPreMergeSummary };
}

// ---------------------------------------------------------------------------
// Batch Scanning Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable key for a set of character names (sorted, lowercased).
 * @param {string[]} names - Character names
 * @returns {string} Sorted, lowercased, pipe-delimited key
 */
function _characterGroupKey(names) {
    return [...names]
        .map((n) => n.toLowerCase().trim())
        .sort()
        .join('|');
}

/**
 * Group non-archived event memories by **pairwise** character overlap.
 *
 * Unlike Tier 1's strict exact-set matching, this generates a group key for
 * every 2-character **subset** of `characters_involved`. A memory about
 * `{Alex, Ezra, Bob}` is added to groups `alex|bob`, `alex|ezra`, and
 * `bob|ezra`, so it will be compared against memories about any of those
 * pairs. This eliminates witness-set drift without making the fast Tier 1
 * path more expensive.
 *
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
        const chars = (m.characters_involved || []).map((c) => c.toLowerCase().trim());
        if (chars.length < 2) continue;

        // Generate all 2-element subsets (pairs) and add to each group
        const seen = new Set();
        for (let i = 0; i < chars.length; i++) {
            for (let j = i + 1; j < chars.length; j++) {
                const key = [chars[i], chars[j]].sort().join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(m);
            }
        }
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
 * @param {Object<string, number>} [options.analyzedCache] - Persisted map of already-analyzed pair keys; checked to skip and updated after each verification
 * @returns {Promise<Array<{older: string, newer: string, merged: boolean, reason: string}>>}
 *   Array of results with memory IDs and merge status
 */
export async function batchContradictionScan(allMemories, options = {}) {
    const { maxCalls = 5, confidenceThreshold = 0.7, autoMerge = false, analyzedCache = null } = options;

    const groups = groupMemoriesByCharacterPair(allMemories);

    let callsUsed = 0;
    let candidatesConsidered = 0;
    let cachedSkips = 0;
    const results = [];

    for (const [_pairKey, groupMemories] of groups) {
        if (callsUsed >= maxCalls) break;
        if (groupMemories.length < 2) continue;

        const suspicious = findSuspiciousPairs(groupMemories, maxCalls - callsUsed);

        for (const [memA, memB] of suspicious) {
            if (callsUsed >= maxCalls) break;

            // Skip pairs already analyzed (and unchanged since) — avoids re-spending
            // LLM calls on the same pair every scan. The key embeds each summary's
            // hash, so an edited/merged memory re-qualifies automatically.
            candidatesConsidered++;
            if (isPairAnalyzed(analyzedCache, memA, memB)) {
                cachedSkips++;
                continue;
            }

            try {
                const charNames = [
                    ...new Set([...(memA.characters_involved || []), ...(memB.characters_involved || [])]),
                ];

                const result = await verifyContradiction(memA, memB, charNames, { confidenceThreshold });
                callsUsed++;
                recordAnalyzedPair(analyzedCache, memA, memB);

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

    logDebug(
        `Batch contradiction scan: ${results.length} contradiction(s) found; ` +
            `${callsUsed}/${maxCalls} LLM calls used; ` +
            `${candidatesConsidered} candidate pair(s) considered, ${cachedSkips} skipped via cache; ` +
            `${groups.size} character group(s)`
    );

    return results;
}

// ---------------------------------------------------------------------------
// Post-Extraction Verification Queue
// ---------------------------------------------------------------------------

/**
 * Verify one memory pair with the LLM and, when confirmed + autoMerge, merge them.
 * Always records the pair in `analyzedCache`. Budget/RPM are the caller's concern —
 * this performs exactly one LLM call. Shared by the pair-sentiment and similarity paths.
 *
 * @param {Memory} memA
 * @param {Memory} memB
 * @param {Object} opts
 * @param {number} opts.confidenceThreshold
 * @param {boolean} opts.autoMerge
 * @param {Object<string, number>|null} [opts.analyzedCache]
 * @returns {Promise<{contradicts: boolean, merged: boolean, reason?: string, older?: Memory, newer?: Memory, stSync?: {archived: Memory, updated: Memory, olderPreMergeSummary: string, newerPreMergeSummary: string}}>}
 */
async function verifyAndResolvePair(memA, memB, { confidenceThreshold, autoMerge, analyzedCache = null }) {
    const charNames = [...new Set([...(memA.characters_involved || []), ...(memB.characters_involved || [])])];

    const result = await verifyContradiction(memA, memB, charNames, { confidenceThreshold });
    recordAnalyzedPair(analyzedCache, memA, memB);

    if (!result.contradicts) {
        return { contradicts: false, merged: false, reason: result.reason };
    }

    const older = getRecency(memA) < getRecency(memB) ? memA : memB;
    const newer = older === memA ? memB : memA;

    let stSync;
    let merged = false;
    if (autoMerge && result.merge) {
        stSync = mergeContradictingMemories(older, newer, result.merge);
        await enrichEventsWithEmbeddings([newer]);
        merged = true;
    }

    return { contradicts: true, merged, reason: result.reason, older, newer, stSync };
}

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
 * @param {function(): Promise<void>} [options.rpmDelayFn] - Async callback to wait between LLM calls (RPM spacing)
 * @param {number} [options.maxCalls=3] - Maximum LLM calls to make in this call (cost control)
 * @param {number} [options.skip=0] - Opposing candidates to skip before verifying (lets the batch caller round-robin across events)
 * @param {number} [options.priorCalls=0] - LLM calls already made elsewhere this batch (so the first call here is RPM-spaced when it isn't the batch's first)
 * @param {Object<string, number>} [options.analyzedCache] - Persisted analyzed-pair map; each verified pair is recorded so later batch scans can skip it
 * @returns {Promise<{verified: boolean, merged: boolean, reason?: string, llmCallsUsed: number, opposingTotal?: number, stSync?: { archived: Memory, updated: Memory, olderPreMergeSummary: string, newerPreMergeSummary: string }}>}
 *   Result of the verification, including LLM call count, total opposing candidates, and ST sync info for merges
 */
export async function checkNewMemoryContradictions(newMemory, existingMemories, options = {}) {
    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const enabled = settings.llmContradictionEnabled ?? defaultSettings.llmContradictionEnabled;
    const confidenceThreshold =
        options.confidenceThreshold ??
        settings.llmContradictionConfidence ??
        defaultSettings.llmContradictionConfidence;
    const autoMerge =
        options.autoMerge ?? settings.llmContradictionAutoMerge ?? defaultSettings.llmContradictionAutoMerge;
    const { rpmDelayFn, maxCalls = 3, skip = 0, priorCalls = 0, analyzedCache = null } = options;

    if (!enabled) {
        return { verified: false, merged: false, llmCallsUsed: 0 };
    }

    const newChars = newMemory.characters_involved || [];
    if (newChars.length < 2) {
        return { verified: false, merged: false, llmCallsUsed: 0 };
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
        return { verified: false, merged: false, llmCallsUsed: 0 };
    }

    // Tier 1 pre-filter: only check memories with opposing sentiment
    const newSentiment = classifySentiment(newMemory.summary);
    if (newSentiment.sentiment === Sentiment.NEUTRAL) {
        return { verified: false, merged: false, llmCallsUsed: 0 };
    }

    const opposingMemories = overlappingMemories.filter((m) => {
        const mSentiment = classifySentiment(m.summary);
        return mSentiment.sentiment !== Sentiment.NEUTRAL && mSentiment.sentiment !== newSentiment.sentiment;
    });

    if (opposingMemories.length === 0) {
        return { verified: false, merged: false, llmCallsUsed: 0 };
    }

    // Tier 2: LLM verification for opposing memories. `skip` lets the batch caller
    // round-robin across events (verify candidate [skip] this pass); `maxCalls` caps
    // how many candidates we verify in this single invocation.
    const opposingTotal = opposingMemories.length;
    const toCheck = opposingMemories.slice(skip, skip + maxCalls);
    let llmCallsUsed = 0;

    for (const existing of toCheck) {
        // Per-call RPM spacing — avoids bursting RPM-limited / local users.
        // priorCalls counts calls already made elsewhere in the batch, so the first
        // call of this invocation is also spaced unless it's the batch's very first.
        if (priorCalls + llmCallsUsed > 0 && rpmDelayFn) {
            await rpmDelayFn();
        }

        try {
            // verifyAndResolvePair records the pair in analyzedCache. (No need to *check*
            // the cache here — a freshly extracted memory's pairs are always new.)
            const outcome = await verifyAndResolvePair(newMemory, existing, {
                confidenceThreshold,
                autoMerge,
                analyzedCache,
            });
            llmCallsUsed++;

            if (outcome.contradicts) {
                return {
                    verified: true,
                    merged: outcome.merged,
                    reason: outcome.reason,
                    llmCallsUsed,
                    opposingTotal,
                    stSync: outcome.stSync,
                };
            }
        } catch (error) {
            llmCallsUsed++;
            logWarn(`Post-extraction contradiction check failed: ${error.message}`);
            // Continue checking other pairs — don't let one failure stop the queue
        }
    }

    return { verified: true, merged: false, llmCallsUsed, opposingTotal };
}

/**
 * Similarity-gated contradiction check (opt-in). Instead of grouping by character PAIR
 * + relationship sentiment, this finds the prior memories most semantically similar to
 * `newMemory` (by embedding cosine) and LLM-verifies the closest ones. It catches
 * single-character state changes the pair/sentiment path misses — e.g. "Alex broke his
 * arm" → later "Alex's arm healed" (both are sentiment-neutral and single-character).
 *
 * Similarity ranking also sidesteps the "main character is in everything" blow-up: even
 * if the protagonist appears in hundreds of memories, only the closest matches are checked.
 *
 * Requires local embeddings — under the `st_vector` source vectors live in ST's DB, not
 * on the memory objects, so `getEmbedding` returns null and this skips cleanly.
 *
 * @param {Memory} newMemory - Newly extracted memory
 * @param {Memory[]} priorMemories - Candidate existing memories (the new batch excluded)
 * @param {Object} [options={}]
 * @param {number} [options.maxCalls=1] - Max LLM verifications in this call
 * @param {number} [options.similarityThreshold] - Min cosine similarity to consider a candidate
 * @param {number} [options.confidenceThreshold]
 * @param {boolean} [options.autoMerge]
 * @param {function(): Promise<void>} [options.rpmDelayFn]
 * @param {number} [options.priorCalls=0] - LLM calls already made this batch (for RPM spacing)
 * @param {Object<string, number>} [options.analyzedCache] - Shared analyzed-pair cache (checked + recorded)
 * @returns {Promise<{verified: boolean, merged: boolean, reason?: string, llmCallsUsed: number, candidateTotal: number, stSync?: {archived: Memory, updated: Memory, olderPreMergeSummary: string, newerPreMergeSummary: string}}>}
 */
export async function checkMemorySimilarContradictions(newMemory, priorMemories, options = {}) {
    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const confidenceThreshold =
        options.confidenceThreshold ??
        settings.llmContradictionConfidence ??
        defaultSettings.llmContradictionConfidence;
    const autoMerge =
        options.autoMerge ?? settings.llmContradictionAutoMerge ?? defaultSettings.llmContradictionAutoMerge;
    const similarityThreshold =
        options.similarityThreshold ??
        settings.llmContradictionSimilarityThreshold ??
        defaultSettings.llmContradictionSimilarityThreshold;
    const { rpmDelayFn, maxCalls = 1, priorCalls = 0, analyzedCache = null } = options;

    const newVec = getEmbedding(newMemory);
    if (!newVec) {
        return { verified: false, merged: false, llmCallsUsed: 0, candidateTotal: 0 };
    }

    const newChars = new Set((newMemory.characters_involved || []).map((c) => c.toLowerCase()));

    // Candidate pool: non-archived, non-reflection priors that share ≥1 character and
    // have a local embedding. Character overlap is a cheap relevance gate; embedding
    // similarity does the real selection.
    const scored = [];
    for (const m of priorMemories) {
        if (m.id === newMemory.id) continue;
        if (m.archived || m.type === 'reflection') continue;
        const mChars = m.characters_involved || [];
        if (mChars.length === 0) continue;
        if (newChars.size > 0 && !mChars.some((c) => newChars.has(c.toLowerCase()))) continue;
        const vec = getEmbedding(m);
        if (!vec) continue;
        const sim = cosineSimilarity(newVec, vec);
        if (sim >= similarityThreshold) scored.push({ m, sim });
    }

    if (scored.length === 0) {
        return { verified: false, merged: false, llmCallsUsed: 0, candidateTotal: 0 };
    }

    // Most-similar first — the closest prior is the likeliest update/contradiction.
    scored.sort((a, b) => b.sim - a.sim);
    const candidateTotal = scored.length;

    let llmCallsUsed = 0;
    for (const { m: existing } of scored) {
        if (llmCallsUsed >= maxCalls) break;
        // Shared cache: skip pairs already verified (and unchanged) by either path.
        if (isPairAnalyzed(analyzedCache, newMemory, existing)) continue;

        if (priorCalls + llmCallsUsed > 0 && rpmDelayFn) {
            await rpmDelayFn();
        }

        try {
            const outcome = await verifyAndResolvePair(newMemory, existing, {
                confidenceThreshold,
                autoMerge,
                analyzedCache,
            });
            llmCallsUsed++;
            if (outcome.contradicts) {
                return {
                    verified: true,
                    merged: outcome.merged,
                    reason: outcome.reason,
                    llmCallsUsed,
                    candidateTotal,
                    stSync: outcome.stSync,
                };
            }
        } catch (error) {
            llmCallsUsed++;
            logWarn(`Similarity contradiction check failed: ${error.message}`);
        }
    }

    return { verified: true, merged: false, llmCallsUsed, candidateTotal };
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
