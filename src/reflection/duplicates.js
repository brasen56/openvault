/**
 * OpenVault Retrospective Reflection Duplicate Detection
 *
 * The *retrospective* counterpart to `filterDuplicateReflections` in `reflect.js`.
 * That function runs at synthesis time and rejects (≥0.90) or replaces (0.80–0.89)
 * near-duplicate reflections before they ever land. This module is the second line
 * of defense: it scans reflections that *already persist* in the vault and surfaces
 * pairs that slipped past the synthesis-time gate (e.g. embeddings drifted between
 * cycles, or two reflections landed in separate synthesis runs).
 *
 * For this reason the default threshold (0.72) sits *below* the synthesis-time
 * replace band (0.80) — this module reports what synthesis-time dedup missed,
 * rather than re-reporting pairs already rejected/replaced there.
 *
 * Pure: no LLM, no network, no DOM, no mutation. Reuses the same embedding codec
 * and cosine-similarity primitives as the synthesis-time dedup. See
 * ROADMAP_Drift_Defense.md → Phase 1.
 */

import { cosineSimilarity } from '../retrieval/math.js';
import { getEmbedding, hasEmbedding } from '../utils/embedding-codec.js';

/**
 * Default cosine-similarity threshold for retrospective near-duplicate detection.
 * Sits below the synthesis-time replace band (REFLECTION_DEDUP_REPLACE_THRESHOLD
 * = 0.80) so this module surfaces what that gate missed.
 */
export const DEFAULT_REFLECTION_DUPLICATE_THRESHOLD = 0.72;

/**
 * A candidate near-duplicate pair of reflections.
 * @typedef {Object} DuplicateReflectionPair
 * @property {Object} a - One reflection (the earlier, by created_at, when known)
 * @property {Object} b - The other reflection
 * @property {number} cosineSim - Cosine similarity in [0, 1]
 */

/**
 * Find near-duplicate reflection pairs for a single character via embedding
 * cosine similarity.
 *
 * Pure — no mutation, no I/O. Reflections are compared pairwise within the
 * provided list; pairs whose cosine similarity is ≥ `threshold` are returned,
 * sorted most-similar first. Pairs already reviewed
 * (`a._dup_reviewed && b._dup_reviewed`) are skipped, mirroring the event
 * duplicates UI in `src/ui/duplicates.js`. Reflections lacking an embedding are
 * skipped (they can't be scored).
 *
 * @param {Object[]} reflections - Reflections for ONE character (already
 *   filtered to `type === 'reflection' && !archived && character matches` by the
 *   caller — typically via `buildCharacterDossier`'s filter)
 * @param {{ threshold?: number }} [options]
 * @param {number} [options.threshold=DEFAULT_REFLECTION_DUPLICATE_THRESHOLD] -
 *   Minimum cosine similarity to flag a pair. Should sit below the
 *   synthesis-time replace band (0.80) to avoid re-reporting handled pairs.
 * @returns {DuplicateReflectionPair[]} Candidate pairs, most-similar first
 */
export function findNearDuplicateReflections(reflections, options = {}) {
    const threshold = Number.isFinite(options?.threshold)
        ? Math.max(0, Math.min(1, options.threshold))
        : DEFAULT_REFLECTION_DUPLICATE_THRESHOLD;

    if (!Array.isArray(reflections) || reflections.length < 2) return [];

    // Only reflections with an embedding can be scored.
    const scored = reflections.filter((r) => hasEmbedding(r));
    const pairs = [];

    for (let i = 0; i < scored.length; i++) {
        for (let j = i + 1; j < scored.length; j++) {
            const a = scored[i];
            const b = scored[j];

            // Skip pairs the user already resolved via the duplicates UI.
            if (a._dup_reviewed && b._dup_reviewed) continue;

            const vecA = getEmbedding(a);
            const vecB = getEmbedding(b);
            if (!vecA || !vecB) continue; // defensive — hasEmbedding should gate this

            const sim = cosineSimilarity(vecA, vecB);
            if (sim >= threshold) {
                // Order so `a` is the earlier reflection when timestamps are
                // known, for stable display. Falls back to id comparison.
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

    // Most-similar first; tiebreak by earliest created_at for stable ordering.
    pairs.sort((x, y) => {
        if (y.cosineSim !== x.cosineSim) return y.cosineSim - x.cosineSim;
        const ax = x.a.created_at || 0;
        const ay = y.a.created_at || 0;
        return ax - ay;
    });

    return pairs;
}

/**
 * Merge one reflection into another, preserving the evidence trail.
 *
 * Archives the absorbed reflection (never deletes — the evidence chain survives
 * and it stops influencing retrieval/reflection), and unions its `source_ids`
 * and `parent_ids` into the survivor so no cited evidence is lost. Mutates both
 * reflections in place; the caller is responsible for persisting the vault.
 *
 * Mirrors the archive-on-merge semantics of the synthesis-time dedup
 * (`filterDuplicateReflections` → `archive_reason`, `merged_into`) and the
 * event duplicates UI (`handleDuplicateAction` → `archive`).
 *
 * @param {Object} survivor - The reflection that remains active (mutated)
 * @param {Object} absorbed - The reflection to archive (mutated: archived=true)
 * @returns {void}
 */
export function mergeReflectionInto(survivor, absorbed) {
    if (!survivor || !absorbed || survivor === absorbed) return;

    // Union the evidence trail onto the survivor.
    const unionIds = (base, extra) => [...new Set([...(base || []), ...(extra || [])])];
    survivor.source_ids = unionIds(survivor.source_ids, absorbed.source_ids);
    survivor.parent_ids = unionIds(survivor.parent_ids, absorbed.parent_ids);

    // Archive the absorbed reflection, preserving the trail back to the survivor.
    absorbed.archived = true;
    absorbed.archive_reason = 'near_duplicate_merge';
    absorbed.merged_into = survivor.id;

    // Mark both as reviewed so the pair stops being re-suggested after resolution.
    absorbed._dup_reviewed = true;
    survivor._dup_reviewed = true;
}