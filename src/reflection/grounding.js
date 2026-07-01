/**
 * OpenVault Reflection Grounding Check (Drift Defense — Phase 3)
 *
 * Flag-only grounding check that runs at *synthesis time*. Catches an
 * ungrounded reflection — one whose text is semantically far from the evidence
 * it *actually cites* — before it lands in the dossier.
 *
 * Grounding is checked against the FULL cited evidence set:
 *   `source_ids`  — cited **event** ids (non-`ref_`)
 *   `parent_ids`  — cited **reflection** ids (`ref_`-prefixed)
 * The comparison set is `source_ids ∪ parent_ids`. Embeddings of both cited
 * events AND cited parent reflections are compared against the new reflection.
 *
 * This is level-correct by construction: a level-3 headline is naturally
 * distant from raw events but *close to the reflections it synthesizes*. Both
 * buckets are in the comparison set, so the check handles abstraction
 * naturally without a per-level threshold. (Checking against events alone
 * would flag legitimate higher-level synthesis as "ungrounded," suppressing
 * exactly the reflection-of-reflection evolution this layer exists to enable.)
 *
 * Pure: no LLM, no network, no DOM, no mutation. Reuses the same embedding
 * codec and cosine-similarity primitives as the synthesis-time dedup. See
 * ROADMAP_Drift_Defense.md → Phase 3.
 */

import { cosineSimilarity } from '../retrieval/math.js';
import { getEmbedding, hasEmbedding } from '../utils/embedding-codec.js';

/**
 * Default cosine-similarity floor for grounding. A reflection whose text is an
 * abstraction of its evidence will be *less* similar than a near-duplicate
 * (0.72) but should still share semantic content with what it cites. A
 * hallucinated/ungrounded reflection scores near 0 against all cited items.
 *
 * 0.30 is deliberately low — the goal is to catch completely unrelated text,
 * not to enforce tight paraphrasing. Legitimate abstraction that drifts from
 * raw events but stays close to its parent reflections is not flagged because
 * the parents are in the comparison set. Tunable via settings.
 */
export const DEFAULT_REFLECTION_GROUNDING_THRESHOLD = 0.3;

/**
 * Result of a grounding check on a single reflection.
 * @typedef {Object} GroundingResult
 * @property {boolean} grounded - Whether the reflection is grounded in its
 *   cited evidence (max similarity ≥ threshold, or indeterminate — never
 *   false-positive on missing data)
 * @property {number} maxSimilarity - Highest cosine similarity to any cited
 *   evidence item that had an embedding. 0 when no evidence was cited or no
 *   cited item had an embedding.
 * @property {string[]} checkedEvidenceIds - IDs of cited evidence items that
 *   had embeddings and were compared
 * @property {string[]} missingEvidenceIds - IDs of cited evidence items whose
 *   embedding was missing (skipped — absence is not treated as distance)
 * @property {string|null} reason - Why the reflection is ungrounded, or null
 *   when grounded. One of: 'no_cited_evidence', 'low_grounding_similarity'.
 */

/**
 * Check whether a reflection is grounded in the union of its cited evidence.
 *
 * Compares the reflection's embedding against the embeddings of its cited
 * events (`source_ids`) and parent reflections (`parent_ids`), returning the
 * max cosine similarity and a grounded/ungrounded verdict.
 *
 * Pure — no mutation, no I/O. The reflection must have an embedding (generated
 * at synthesis time before this check runs). Cited evidence items without an
 * embedding are skipped (not treated as distance).
 *
 * Edge cases:
 *  - Reflection citing NO evidence at all → ungrounded by definition
 *    (`reason: 'no_cited_evidence'`), independent of similarity.
 *  - Cited id whose embedding is missing → skipped, added to
 *    `missingEvidenceIds`. If ALL cited ids are missing embeddings, the check
 *    is indeterminate → returns `grounded: true` (never false-positives on
 *    missing data).
 *  - Reflection itself lacking an embedding → indeterminate → `grounded: true`
 *    (can't score; the wiring path generates embeddings before calling this).
 *
 * @param {Object} reflection - A reflection memory with `source_ids`,
 *   `parent_ids`, and an embedding
 * @param {Object[]} allMemories - Full memory stream (used to look up cited
 *   evidence by id). The caller passes the same `allMemories` the synthesis
 *   pipeline already holds.
 * @param {{ threshold?: number }} [options]
 * @param {number} [options.threshold=DEFAULT_REFLECTION_GROUNDING_THRESHOLD] -
 *   Minimum max-cosine-similarity to the cited evidence set for the reflection
 *   to count as grounded. Below this, the reflection is flagged ungrounded.
 * @returns {GroundingResult}
 */
export function checkReflectionGrounding(reflection, allMemories, options = {}) {
    const threshold = Number.isFinite(options?.threshold)
        ? Math.max(0, Math.min(1, options.threshold))
        : DEFAULT_REFLECTION_GROUNDING_THRESHOLD;

    // Can't score without an embedding — indeterminate, don't flag.
    if (!reflection || !hasEmbedding(reflection)) {
        return {
            grounded: true,
            maxSimilarity: 0,
            checkedEvidenceIds: [],
            missingEvidenceIds: [],
            reason: null,
        };
    }

    // Union of cited evidence: source_ids (events) ∪ parent_ids (reflections).
    const citedIds = [...new Set([...(reflection.source_ids || []), ...(reflection.parent_ids || [])])];

    // Edge case: a reflection citing no evidence at all is ungrounded by
    // definition, independent of similarity.
    if (citedIds.length === 0) {
        return {
            grounded: false,
            maxSimilarity: 0,
            checkedEvidenceIds: [],
            missingEvidenceIds: [],
            reason: 'no_cited_evidence',
        };
    }

    // Build a lookup map for fast id → memory resolution.
    const memoryMap = new Map();
    if (Array.isArray(allMemories)) {
        for (const m of allMemories) {
            if (m?.id != null) memoryMap.set(m.id, m);
        }
    }

    const reflectionVec = getEmbedding(reflection);
    const checkedEvidenceIds = [];
    const missingEvidenceIds = [];
    let maxSimilarity = 0;

    for (const id of citedIds) {
        const evidence = memoryMap.get(id);
        if (!evidence || !hasEmbedding(evidence)) {
            // Skip cited ids whose embedding is missing — don't treat absence
            // as distance.
            missingEvidenceIds.push(id);
            continue;
        }

        const evidenceVec = getEmbedding(evidence);
        if (!evidenceVec) {
            // Defensive — hasEmbedding should gate this.
            missingEvidenceIds.push(id);
            continue;
        }

        const sim = cosineSimilarity(reflectionVec, evidenceVec);
        checkedEvidenceIds.push(id);
        if (sim > maxSimilarity) {
            maxSimilarity = sim;
        }
    }

    // If ALL cited evidence lacked embeddings, the check is indeterminate —
    // don't false-positive on missing data.
    if (checkedEvidenceIds.length === 0) {
        return {
            grounded: true,
            maxSimilarity: 0,
            checkedEvidenceIds: [],
            missingEvidenceIds,
            reason: null,
        };
    }

    const grounded = maxSimilarity >= threshold;

    return {
        grounded,
        maxSimilarity,
        checkedEvidenceIds,
        missingEvidenceIds,
        reason: grounded ? null : 'low_grounding_similarity',
    };
}

/**
 * A reflection that failed the grounding check.
 * @typedef {Object} UngroundedReflection
 * @property {Object} reflection - The ungrounded reflection
 * @property {number} maxSimilarity - Max cosine similarity to cited evidence
 * @property {string[]} checkedEvidenceIds - Evidence IDs that were compared
 * @property {string[]} missingEvidenceIds - Evidence IDs skipped (no embedding)
 * @property {string} reason - Why ungrounded ('no_cited_evidence' or 'low_grounding_similarity')
 */

/**
 * Find ungrounded reflections from a batch by checking each against its cited
 * evidence.
 *
 * Batch wrapper around `checkReflectionGrounding`. Returns only the
 * reflections that failed the check (flag-only). Reflections already reviewed
 * (`_grounding_reviewed`) are skipped so resolved flags don't re-surface.
 *
 * Pure — no mutation, no I/O.
 *
 * @param {Object[]} reflections - Newly generated or existing reflections
 * @param {Object[]} allMemories - Full memory stream (for evidence lookup)
 * @param {{ threshold?: number }} [options] - See `checkReflectionGrounding`
 * @returns {UngroundedReflection[]} Reflections that failed grounding, in input order
 */
export function findUngroundedReflections(reflections, allMemories, options = {}) {
    if (!Array.isArray(reflections)) return [];

    const ungrounded = [];

    for (const reflection of reflections) {
        // Skip reflections the user already reviewed via the dossier UI.
        if (reflection?._grounding_reviewed) continue;

        const result = checkReflectionGrounding(reflection, allMemories, options);

        if (!result.grounded) {
            ungrounded.push({
                reflection,
                maxSimilarity: result.maxSimilarity,
                checkedEvidenceIds: result.checkedEvidenceIds,
                missingEvidenceIds: result.missingEvidenceIds,
                reason: result.reason,
            });
        }
    }

    return ungrounded;
}

/**
 * Stamp a grounding check result onto a reflection object.
 *
 * Attaches `grounding_similarity`, `grounding_flagged`, and `grounding_reason`
 * so the dossier can surface the flag without re-running the check. Mirrors
 * how synthesis-time dedup stamps `archive_reason` / `merged_into`.
 *
 * Mutates the reflection in place; the caller persists the vault.
 *
 * @param {Object} reflection - The reflection to stamp (mutated)
 * @param {GroundingResult} result - Result from `checkReflectionGrounding`
 * @returns {void}
 */
export function stampGroundingResult(reflection, result) {
    if (!reflection || !result) return;

    reflection.grounding_similarity = result.maxSimilarity;
    reflection.grounding_flagged = !result.grounded;
    reflection.grounding_reason = result.grounded ? null : result.reason;
}