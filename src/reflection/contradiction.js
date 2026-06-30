/**
 * OpenVault Reflection Contradiction Detection (Drift Defense — Phase 2)
 *
 * Flag-only drift detection over reflections. Surfaces conflicting
 * present-tense traits ("trusts the party" vs. "refuses to be vulnerable")
 * as drift warnings on the dossier card.
 *
 * **Why fork, not reuse** — the existing event-oriented LLM contradiction
 * pipeline (`src/retrieval/llm-contradiction.js`) cannot be pointed at
 * reflections as-is:
 *  1. It groups by character *pair* + opposing sentiment; a reflection is
 *     about one character's internal trait, not a pair's relationship state.
 *  2. Its prompt explicitly suppresses "enemies → friends" as development —
 *     which would suppress exactly the conflict this module exists to catch.
 *
 * This module reuses the *architectural template* (LLM call shape, confidence
 * threshold, `contradiction_analyzed` cache pattern, batch interval, max-calls
 * cap) but forks the grouping, pre-filter, and prompt.
 *
 * The hard part: **drift vs. development**. Two contradictory present-tense
 * traits about the same character are drift (flag). A superseded past trait
 * plus a newer evolved one is development (do not flag). The discriminator is
 * temporal ordering via `created_at` / `extraction_count`, which the forked
 * prompt receives and is instructed to use.
 *
 * See ROADMAP_Drift_Defense.md → Phase 2.
 */

/** @typedef {import('../types').Memory} Memory */

import { defaultSettings, extensionName } from '../constants.js';
import { getDeps } from '../deps.js';
import { callLLM, callOpenAICompat, LLM_CONFIGS } from '../llm.js';
import { parseReflectionContradictionResponse } from '../extraction/structured.js';
import { record } from '../perf/store.js';
import { cyrb53, getEmbedding, hasEmbedding } from '../utils/embedding-codec.js';
import { logDebug, logWarn } from '../utils/logging.js';
import { cosineSimilarity } from '../retrieval/math.js';

/**
 * Default cosine-similarity threshold for the embeddings pre-filter candidate
 * band. Thematically adjacent but potentially opposed — an over-fetch that
 * defers the real decision to the LLM. Sits below the Phase 1 near-duplicate
 * band (0.72) so near-dupes don't get re-flagged as contradictions.
 */
export const DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD = 0.45;

/** Max entries kept in the persisted analyzed-pair cache (FIFO-trimmed). */
const MAX_ANALYZED_PAIRS = 5000;

// ---------------------------------------------------------------------------
// Pure: Embeddings Pre-Filter
// ---------------------------------------------------------------------------

/**
 * Find candidate reflection pairs for contradiction verification via embedding
 * cosine similarity.
 *
 * Per-character (not per-pair): groups reflections by `character`, then scores
 * each pair within the group. The candidate band is `threshold ≤ sim < dupBand`
 * — thematically adjacent (catches "trusts" vs. "refuses to be vulnerable") but
 * below the near-duplicate band (those are Phase 1's job, not contradictions).
 *
 * Pure — no mutation, no I/O. Reflections without embeddings or already resolved
 * (`_drift_reviewed` on both) are skipped.
 *
 * @param {Object[]} reflections - Reflections for ONE character (already
 *   filtered to `type === 'reflection' && !archived && character matches` by
 *   the caller — typically via `buildCharacterDossier`'s filter)
 * @param {{ threshold?: number, dupBand?: number }} [options]
 * @param {number} [options.threshold=DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD] -
 *   Minimum cosine similarity to consider a candidate.
 * @param {number} [options.dupBand=0.72] - Upper bound: pairs at/above this are
 *   near-duplicates (Phase 1's domain), not contradictions. Skipped here.
 * @returns {Array<{ a: Object, b: Object, cosineSim: number }>} Candidate pairs,
 *   most-similar first. `a` is the earlier reflection (by created_at) when known.
 */
export function findContradictionCandidates(reflections, options = {}) {
    const threshold = Number.isFinite(options?.threshold)
        ? Math.max(0, Math.min(1, options.threshold))
        : DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD;
    const dupBand = Number.isFinite(options?.dupBand)
        ? Math.max(0, Math.min(1, options.dupBand))
        : 0.72; // DEFAULT_REFLECTION_DUPLICATE_THRESHOLD — Phase 1's floor

    if (!Array.isArray(reflections) || reflections.length < 2) return [];

    const scored = reflections.filter((r) => hasEmbedding(r));
    const pairs = [];

    for (let i = 0; i < scored.length; i++) {
        for (let j = i + 1; j < scored.length; j++) {
            const a = scored[i];
            const b = scored[j];

            // Skip pairs the user already resolved via the drift UI.
            if (a._drift_reviewed && b._drift_reviewed) continue;

            const vecA = getEmbedding(a);
            const vecB = getEmbedding(b);
            if (!vecA || !vecB) continue;

            const sim = cosineSimilarity(vecA, vecB);

            // Candidate band: adjacent enough to be related, below the dupe band.
            if (sim >= threshold && sim < dupBand) {
                const aFirst =
                    typeof a.created_at === 'number' && typeof b.created_at === 'number'
                        ? a.created_at <= b.created_at
                        : String(a.id || '') <= String(b.id || '');
                pairs.push({
                    a: aFirst ? a : b,
                    b: aFirst ? b : a,
                    cosineSim: sim,
                });
            }
        }
    }

    // Most-similar first (closest to the dup band = most likely to conflict);
    // tiebreak by earliest created_at for stable ordering.
    pairs.sort((x, y) => {
        if (y.cosineSim !== x.cosineSim) return y.cosineSim - x.cosineSim;
        const ax = x.a.created_at || 0;
        const ay = y.a.created_at || 0;
        return ax - ay;
    });

    return pairs;
}

// ---------------------------------------------------------------------------
// Pure: Analyzed-Pair Cache (forked from llm-contradiction.js, re-keyed)
// ---------------------------------------------------------------------------

/**
 * Stable cache key for a reflection pair. Embeds a content hash of each summary
 * so the entry self-invalidates when either reflection's text changes
 * (edit/archive), mirroring the event cache's `analyzedPairKey`.
 *
 * Prefixed `rdrift:` to namespace it apart from the event-oriented cache entries
 * that live in the same `contradiction_analyzed` map (so the two caches can share
 * storage without key collision).
 *
 * @param {Memory} memA
 * @param {Memory} memB
 * @returns {string}
 */
export function driftPairKey(memA, memB) {
    const a = `rdrift:${memA.id}:${cyrb53(memA.summary || '')}`;
    const b = `rdrift:${memB.id}:${cyrb53(memB.summary || '')}`;
    return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * True if this exact reflection pair (with unchanged summaries) was already
 * analyzed.
 * @param {Object<string, number>|null|undefined} cache
 * @param {Memory} memA
 * @param {Memory} memB
 */
export function isDriftPairAnalyzed(cache, memA, memB) {
    return !!cache && cache[driftPairKey(memA, memB)] === 1;
}

/**
 * Record a reflection pair as analyzed, trimming oldest entries past
 * MAX_ANALYZED_PAIRS.
 * @param {Object<string, number>|null|undefined} cache
 * @param {Memory} memA
 * @param {Memory} memB
 */
export function recordDriftPairAnalyzed(cache, memA, memB) {
    if (!cache) return;
    cache[driftPairKey(memA, memB)] = 1;
    const keys = Object.keys(cache);
    if (keys.length > MAX_ANALYZED_PAIRS) {
        for (const k of keys.slice(0, keys.length - MAX_ANALYZED_PAIRS)) delete cache[k];
    }
}

// ---------------------------------------------------------------------------
// Pure: Prompt Construction (forked — drift vs. development)
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt for reflection drift verification.
 *
 * Forked from `buildContradictionVerificationPrompt` — the event pipeline's
 * prompt explicitly suppresses "enemies → friends" as development, which would
 * treat the conflicts we want to surface as non-contradictions. This prompt
 * instead asks the verifier to classify the pair as drift, development, or
 * consistent, and receives both reflections' timestamps to make the temporal
 * judgment.
 *
 * @param {Memory} reflectionA - First reflection (the earlier, by created_at)
 * @param {Memory} reflectionB - Second reflection (the later)
 * @param {string} characterName - The character both reflections describe
 * @returns {Array<{role: string, content: string}>} Messages array for callLLM
 */
export function buildReflectionContradictionPrompt(reflectionA, reflectionB, characterName) {
    const userMessage = `You are analyzing character insights from a roleplay session. Determine whether these two insights about the same character represent DRIFT, DEVELOPMENT, or are CONSISTENT.

CHARACTER: ${characterName}

INSIGHT A (created at message ${reflectionA.extraction_count ?? 0}, timestamp ${reflectionA.created_at ?? 0}):
"${reflectionA.summary}"

INSIGHT B (created at message ${reflectionB.extraction_count ?? 0}, timestamp ${reflectionB.created_at ?? 0}):
"${reflectionB.summary}"

Respond in JSON:
{
  "classification": "drift" | "development" | "consistent",
  "confidence": 0.0-1.0,
  "reason": "brief explanation",
  "surviving_summary": null OR "the trait that should survive if drift"
}

Classification rules:
- DRIFT: Both insights describe the character's CURRENT state in mutually exclusive ways — they cannot both be true simultaneously. This indicates the character model has drifted (e.g. "trusts the party" vs. "refuses to be vulnerable"). Flag these for human review.
- DEVELOPMENT: The NEWER insight supersedes the older one on the same axis. The character genuinely evolved from one state to another (e.g. past "refuses to trust" → present "trusts the party"). This is NOT drift — it is growth. Use the timestamps and extraction counts to determine temporal order. The older insight describes a state the character has since moved past.
- CONSISTENT: The insights do not conflict. They may be adjacent or complementary aspects of the character (e.g. "values loyalty" and "protective of friends"). No action needed.

Key distinction: Drift = two present-tense traits that conflict. Development = an old state replaced by a newer one. The timestamps (INSIGHT A is earlier) tell you which is older.

If classification is "drift", provide surviving_summary: the trait that should become canon (usually the one more strongly supported by evidence, or the more recent if both are recent). If classification is "development" or "consistent", surviving_summary should be null.`;

    return [{ role: 'user', content: userMessage }];
}

// ---------------------------------------------------------------------------
// Core: LLM Drift Verification
// ---------------------------------------------------------------------------

/**
 * Use LLM to classify a reflection pair as drift, development, or consistent.
 *
 * Forked from `verifyContradiction` — uses a separate `LLM_CONFIGS` entry and
 * prompt builder. Same LLM call shape and confidence-threshold gating.
 *
 * @param {Memory} reflectionA - First reflection (the earlier)
 * @param {Memory} reflectionB - Second reflection (the later)
 * @param {string} characterName - The character both describe
 * @param {Object} [options={}]
 * @param {number} [options.confidenceThreshold=0.7] - Minimum confidence to
 *   confirm drift
 * @returns {Promise<{classification: string, confidence: number, survivingSummary: string|null, reason: string}>}
 */
export async function verifyReflectionContradiction(reflectionA, reflectionB, characterName, options = {}) {
    const { confidenceThreshold = 0.7 } = options;
    const t0 = performance.now();

    const messages = buildReflectionContradictionPrompt(reflectionA, reflectionB, characterName);

    logDebug(
        `Reflection drift check: comparing "${reflectionA.summary?.slice(0, 60)}…" vs "${reflectionB.summary?.slice(0, 60)}…"`
    );

    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const useCustomApi = settings.llmContradictionUseCustomApi ?? defaultSettings.llmContradictionUseCustomApi;

    let response;
    if (useCustomApi) {
        const apiUrl = String(settings.llmContradictionApiUrl || '').trim();
        const apiKey = String(settings.llmContradictionApiKey || '').trim();
        const model = String(settings.llmContradictionApiModel || '').trim();

        if (!apiUrl || !model) {
            throw new Error('Reflection drift analysis: custom API enabled but URL or Model is not configured');
        }

        response = await callOpenAICompat(messages, {
            apiUrl,
            apiKey: apiKey || undefined,
            model,
            maxTokens: LLM_CONFIGS.reflectionContradiction.maxTokens,
            timeoutMs: LLM_CONFIGS.reflectionContradiction.timeoutMs,
            errorContext: 'Reflection drift verification (custom API)',
        });
    } else {
        response = await callLLM(messages, LLM_CONFIGS.reflectionContradiction, { structured: true });
    }

    const parsed = parseReflectionContradictionResponse(response);

    // Gate: only confirm drift when confidence is high enough. Development and
    // consistent classifications are always returned (for logging), but only
    // drift below threshold is downgraded to "consistent" so it doesn't surface
    // as a warning.
    let classification = parsed.classification;
    if (classification === 'drift' && parsed.confidence < confidenceThreshold) {
        logDebug(
            `Reflection drift: downgrading low-confidence drift (${parsed.confidence.toFixed(2)} < ${confidenceThreshold}) to consistent`
        );
        classification = 'consistent';
    }

    logDebug(
        `Reflection drift result: ${classification} ` +
            `(confidence: ${parsed.confidence.toFixed(2)}, reason: ${parsed.reason?.slice(0, 80)})`
    );

    record('llm_reflection_contradiction', performance.now() - t0);

    return {
        classification,
        confidence: parsed.confidence,
        survivingSummary: parsed.surviving_summary || null,
        reason: parsed.reason,
    };
}

// ---------------------------------------------------------------------------
// Batch Scan
// ---------------------------------------------------------------------------

/**
 * Result of a single pair's drift verification.
 * @typedef {Object} DriftWarning
 * @property {Object} a - The earlier reflection
 * @property {Object} b - The later reflection
 * @property {string} character - Character name
 * @property {number} confidence - LLM confidence (0-1)
 * @property {string} reason - LLM explanation
 * @property {string|null} survivingSummary - Suggested canon trait
 */

/**
 * Run a batch reflection drift scan over a single character's reflections.
 *
 * This is the main entry point for drift detection. It:
 *  1. Runs the embeddings pre-filter to find candidate pairs (cheap gate)
 *  2. LLM-verifies each candidate (deferred the real drift-vs-development call)
 *  3. Skips pairs already in the `analyzedCache` (re-keyed for reflection pairs)
 *  4. Caps LLM calls at `maxCalls` per scan (cost control)
 *
 * **Flag-only** — confirmed drift pairs are returned as warnings for the UI to
 * surface. This function does NOT archive, merge, or auto-resolve anything.
 *
 * @param {Object[]} reflections - Reflections for ONE character
 * @param {string} characterName - Character name
 * @param {Object} [options={}]
 * @param {number} [options.maxCalls=5] - Maximum LLM calls per scan (cost control)
 * @param {number} [options.confidenceThreshold=0.7] - Minimum confidence to flag drift
 * @param {number} [options.candidateThreshold] - Embeddings pre-filter cosine floor
 * @param {Object<string, number>} [options.analyzedCache] - Persisted map of
 *   already-analyzed pair keys; checked to skip and updated after each verification
 * @returns {Promise<DriftWarning[]>} Confirmed drift warnings (flag-only)
 */
export async function batchReflectionContradictionScan(reflections, characterName, options = {}) {
    const {
        maxCalls = 5,
        confidenceThreshold = 0.7,
        analyzedCache = null,
    } = options;

    const deps = getDeps();
    const settings = deps.getExtensionSettings()?.[extensionName] || {};
    const candidateThreshold =
        options.candidateThreshold ??
        settings.llmReflectionContradictionCandidateThreshold ??
        defaultSettings.llmReflectionContradictionCandidateThreshold;

    // Step 1: embeddings pre-filter (cheap gate)
    const candidates = findContradictionCandidates(reflections, { threshold: candidateThreshold });

    if (candidates.length === 0) {
        logDebug(`Reflection drift scan [${characterName}]: 0 candidates from ${reflections.length} reflections`);
        return [];
    }

    let callsUsed = 0;
    let cachedSkips = 0;
    const warnings = [];

    for (const { a, b, cosineSim } of candidates) {
        if (callsUsed >= maxCalls) break;

        // Skip pairs already analyzed (and unchanged since)
        if (isDriftPairAnalyzed(analyzedCache, a, b)) {
            cachedSkips++;
            continue;
        }

        try {
            const result = await verifyReflectionContradiction(a, b, characterName, { confidenceThreshold });
            callsUsed++;
            recordDriftPairAnalyzed(analyzedCache, a, b);

            if (result.classification === 'drift') {
                warnings.push({
                    a,
                    b,
                    character: characterName,
                    confidence: result.confidence,
                    reason: result.reason,
                    survivingSummary: result.survivingSummary,
                    cosineSim,
                });
            }
        } catch (error) {
            logWarn(`Reflection drift check failed for pair ${a.id}/${b.id}: ${error.message}`);
            callsUsed++;
            // Still record as analyzed so a transient failure doesn't retry forever
            recordDriftPairAnalyzed(analyzedCache, a, b);
        }
    }

    logDebug(
        `Reflection drift scan [${characterName}]: ${warnings.length} drift warning(s); ` +
            `${callsUsed}/${maxCalls} LLM calls used; ` +
            `${candidates.length} candidate(s), ${cachedSkips} skipped via cache`
    );

    return warnings;
}

/**
 * Resolve a drift warning by archiving one reflection and keeping the other.
 *
 * **Flag-only resolution** — the user picks which reflection survives (canon).
 * The archived reflection's evidence trail is unioned onto the survivor (same
 * as Phase 1's `mergeReflectionInto`), and both are marked `_drift_reviewed`
 * so the pair stops being re-suggested.
 *
 * If `canonText` is provided (user-authored or pre-filled from the LLM's
 * `survivingSummary`), it's set as the survivor's summary — making the canon
 * explicit. Otherwise the survivor's existing summary is kept.
 *
 * @param {Object} survivor - The reflection that remains active (mutated)
 * @param {Object} absorbed - The reflection to archive (mutated: archived=true)
 * @param {string|null} [canonText] - Optional canon summary for the survivor
 * @returns {void}
 */
export function resolveDriftWarning(survivor, absorbed, canonText = null) {
    if (!survivor || !absorbed || survivor === absorbed) return;

    // Union the evidence trail onto the survivor (mirrors Phase 1's merge).
    const unionIds = (base, extra) => [...new Set([...(base || []), ...(extra || [])])];
    survivor.source_ids = unionIds(survivor.source_ids, absorbed.source_ids);
    survivor.parent_ids = unionIds(survivor.parent_ids, absorbed.parent_ids);

    // Apply canon text if provided (makes the surviving trait explicit).
    if (canonText && typeof canonText === 'string' && canonText.trim()) {
        survivor.summary = canonText.trim();
    }

    // Archive the absorbed reflection.
    absorbed.archived = true;
    absorbed.archive_reason = 'drift_contradiction';
    absorbed.merged_into = survivor.id;

    // Mark both as reviewed so the pair stops re-surfacing.
    absorbed._drift_reviewed = true;
    survivor._drift_reviewed = true;
}