import { beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_REFLECTION_DUPLICATE_THRESHOLD,
    findNearDuplicateReflections,
    mergeReflectionInto,
} from '../../src/reflection/duplicates.js';

describe('findNearDuplicateReflections', () => {
    beforeEach(() => {
        setupTestContext();
    });

    it('flags pairs at or above the threshold', () => {
        // cos([1,0,0], [0.95, 0.31, 0]) = 0.95 — well above 0.72
        const reflections = [
            makeReflection('ref_a', 'Astarion is vain', [1, 0, 0]),
            makeReflection('ref_b', 'Astarion is prideful', [0.95, 0.31, 0]),
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(1);
        expect(pairs[0].cosineSim).toBeCloseTo(0.95, 2);
    });

    it('does not flag pairs below the threshold', () => {
        // cos([1,0,0], [0.5, 0.87, 0]) = 0.5 — below 0.72
        const reflections = [
            makeReflection('ref_a', 'Astarion is vain', [1, 0, 0]),
            makeReflection('ref_c', 'Gale loves books', [0.5, 0.87, 0]),
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('flags the semantic-near-dupe that lexical Jaccard would miss', () => {
        // "vain" vs "prideful" share ~0 content words, so Jaccard ≈ 0.
        // Here we simulate what embeddings *would* do: high cosine.
        const reflections = [
            makeReflection('ref_a', 'Astarion is vain', [1, 0, 0]),
            makeReflection('ref_b', 'Astarion is prideful', [0.9, 0.44, 0]), // ~0.90 cosine
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(1);
    });

    it('skips reflections without an embedding (no crash)', () => {
        const reflections = [
            makeReflection('ref_a', 'Astarion is vain', [1, 0, 0]),
            makeReflection('ref_no_emb', 'No embedding here', null),
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('skips pairs already reviewed (_dup_reviewed on both)', () => {
        const reflections = [
            { ...makeReflection('ref_a', 'Astarion is vain', [1, 0, 0]), _dup_reviewed: true },
            { ...makeReflection('ref_b', 'Astarion is prideful', [0.95, 0.31, 0]), _dup_reviewed: true },
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('sorts most-similar first', () => {
        // Four reflections → 6 pairs. Three sit above the 0.72 default
        // threshold (A-B ≈ 0.95, A-C ≈ 0.80, B-C ≈ 0.95); D is orthogonal to
        // all (cosine 0) and contributes no flagged pairs.
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0, 0]),
            makeReflection('ref_b', 'B', [0.95, 0.31, 0, 0]),
            makeReflection('ref_c', 'C', [0.8, 0.6, 0, 0]),
            makeReflection('ref_d', 'D', [0, 0, 0, 1]), // orthogonal to A, B, C
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(3);
        // Most-similar first
        expect(pairs[0].cosineSim).toBeGreaterThanOrEqual(pairs[1].cosineSim);
        expect(pairs[1].cosineSim).toBeGreaterThanOrEqual(pairs[2].cosineSim);
        // The top pair is the highest cosine (~0.95)
        expect(pairs[0].cosineSim).toBeCloseTo(0.95, 1);
    });

    it('respects a custom threshold', () => {
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            // 0.75 cosine — flagged at 0.72, not at 0.80
            makeReflection('ref_b', 'B', [0.75, 0.66, 0]),
        ];

        expect(findNearDuplicateReflections(reflections, { threshold: 0.72 })).toHaveLength(1);
        expect(findNearDuplicateReflections(reflections, { threshold: 0.8 })).toHaveLength(0);
    });

    it('clamps threshold to [0, 1]', () => {
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            makeReflection('ref_b', 'B', [0.95, 0.31, 0]),
        ];

        // Below 0 → treated as 0 → everything flagged
        expect(findNearDuplicateReflections(reflections, { threshold: -1 })).toHaveLength(1);
        // Above 1 → treated as 1 → nothing flagged
        expect(findNearDuplicateReflections(reflections, { threshold: 5 })).toHaveLength(0);
    });

    it('orders the pair so `a` is the earlier reflection when created_at is known', () => {
        const reflections = [
            { ...makeReflection('ref_newer', 'newer', [0.95, 0.31, 0]), created_at: 2000 },
            { ...makeReflection('ref_older', 'older', [1, 0, 0]), created_at: 1000 },
        ];

        const pairs = findNearDuplicateReflections(reflections);

        expect(pairs).toHaveLength(1);
        expect(pairs[0].a.id).toBe('ref_older');
        expect(pairs[0].b.id).toBe('ref_newer');
    });

    it('returns [] for empty or single-element input', () => {
        expect(findNearDuplicateReflections([])).toEqual([]);
        expect(findNearDuplicateReflections([makeReflection('only', 'x', [1, 0, 0])])).toEqual([]);
    });

    it('uses DEFAULT_REFLECTION_DUPLICATE_THRESHOLD when no threshold given', () => {
        expect(DEFAULT_REFLECTION_DUPLICATE_THRESHOLD).toBe(0.72);
    });
});

describe('mergeReflectionInto', () => {
    it('archives the absorbed reflection and unions evidence onto the survivor', () => {
        const survivor = makeReflection('ref_survivor', 'survivor', [1, 0, 0]);
        survivor.source_ids = ['evt_1', 'evt_2'];
        survivor.parent_ids = ['ref_parent_1'];
        const absorbed = makeReflection('ref_absorbed', 'absorbed', [0.95, 0.31, 0]);
        absorbed.source_ids = ['evt_2', 'evt_3']; // evt_2 overlaps; evt_3 is new
        absorbed.parent_ids = ['ref_parent_2'];

        mergeReflectionInto(survivor, absorbed);

        // Survivor keeps the union, deduped
        expect(survivor.source_ids).toEqual(['evt_1', 'evt_2', 'evt_3']);
        expect(survivor.parent_ids).toEqual(['ref_parent_1', 'ref_parent_2']);

        // Absorbed is archived with the trail back to the survivor
        expect(absorbed.archived).toBe(true);
        expect(absorbed.archive_reason).toBe('near_duplicate_merge');
        expect(absorbed.merged_into).toBe('ref_survivor');

        // Both marked reviewed so the pair stops re-surfacing
        expect(absorbed._dup_reviewed).toBe(true);
        expect(survivor._dup_reviewed).toBe(true);
    });

    it('handles missing source_ids / parent_ids gracefully', () => {
        const survivor = makeReflection('ref_s', 's', [1, 0, 0]);
        const absorbed = makeReflection('ref_a', 'a', [1, 0, 0]);
        // Neither has source_ids or parent_ids

        mergeReflectionInto(survivor, absorbed);

        expect(survivor.source_ids).toEqual([]);
        expect(survivor.parent_ids).toEqual([]);
        expect(absorbed.archived).toBe(true);
    });

    it('is a no-op when either argument is missing or they are the same', () => {
        const r = makeReflection('ref_x', 'x', [1, 0, 0]);

        mergeReflectionInto(null, r);
        mergeReflectionInto(r, null);
        mergeReflectionInto(r, r);

        expect(r.archived).toBeUndefined();
        expect(r.source_ids).toBeUndefined();
    });
});

/**
 * Build a minimal reflection object for testing.
 * @param {string} id
 * @param {string} summary
 * @param {number[]|null} embedding - Raw vector, or null to omit
 */
function makeReflection(id, summary, embedding) {
    const r = {
        id,
        type: 'reflection',
        character: 'Astarion',
        summary,
        created_at: 1000,
    };
    if (embedding) r.embedding = embedding;
    return r;
}