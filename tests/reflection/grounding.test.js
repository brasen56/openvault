import { describe, expect, it } from 'vitest';
import {
    DEFAULT_REFLECTION_GROUNDING_THRESHOLD,
    checkReflectionGrounding,
    findUngroundedReflections,
    stampGroundingResult,
} from '../../src/reflection/grounding.js';

describe('checkReflectionGrounding', () => {
    it('flags a reflection whose text is unrelated to its cited evidence', () => {
        // Reflection vector [1,0,0] — "Astarion is a master chef"
        // Evidence vector  [0,1,0] — "Astarion fought a vampire"
        // cos = 0 — completely unrelated
        const reflection = makeReflection('ref_1', 'Astarion is a master chef', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        const allMemories = [
            makeMemory('evt_1', 'Astarion fought a vampire', [0, 1, 0]),
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(false);
        expect(result.reason).toBe('low_grounding_similarity');
        expect(result.maxSimilarity).toBe(0);
        expect(result.checkedEvidenceIds).toEqual(['evt_1']);
    });

    it('does NOT flag a reflection grounded in its cited events', () => {
        // cos([1,0,0], [0.95, 0.31, 0]) ≈ 0.95 — well above 0.30
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        const allMemories = [
            makeMemory('evt_1', 'Astarion preened and admired his reflection', [0.95, 0.31, 0]),
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.maxSimilarity).toBeCloseTo(0.95, 1);
    });

    it('grounds against source_ids AND parent_ids (full cited set)', () => {
        // A level-2 reflection far from its cited event but close to its parent.
        // This is legitimate reflection-of-reflection synthesis — must NOT flag.
        const reflection = makeReflection('ref_2', 'Astarion hides deep insecurity', [0, 1, 0], {
            source_ids: ['evt_1'],
            parent_ids: ['ref_1'],
        });
        const allMemories = [
            makeMemory('evt_1', 'Astarion fought a vampire', [1, 0, 0]), // far from reflection (cos 0)
            makeMemory('ref_1', 'Astarion masks vulnerability', [0, 0.95, 0.31]), // close (cos ≈ 0.95)
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        // Max similarity picks the parent (0.95) over the event (0) — grounded.
        expect(result.grounded).toBe(true);
        expect(result.maxSimilarity).toBeCloseTo(0.95, 1);
        expect(result.checkedEvidenceIds).toContain('evt_1');
        expect(result.checkedEvidenceIds).toContain('ref_1');
    });

    it('does NOT flag legitimate higher-level synthesis (distant from events, close to parents)', () => {
        // The motivating case from the roadmap: a level-3 headline abstracts
        // away from raw events but is close to the reflections it synthesizes.
        const reflection = makeReflection('ref_3', 'Astarion is fundamentally self-preserving', [0, 1, 0], {
            source_ids: ['evt_1', 'evt_2'],
            parent_ids: ['ref_1', 'ref_2'],
            level: 3,
        });
        const allMemories = [
            makeMemory('evt_1', 'Astarion swung his dagger', [1, 0, 0]), // cos 0 with reflection
            makeMemory('evt_2', 'Astarion fled the battle', [0.9, 0.1, 0.4]), // cos low
            makeMemory('ref_1', 'Astarion avoids danger', [0.1, 0.9, 0.4]), // cos ≈ 0.95
            makeMemory('ref_2', 'Astarion prioritizes survival', [0, 0.95, 0.31]), // cos ≈ 0.95
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(true);
        expect(result.maxSimilarity).toBeGreaterThan(0.3);
    });

    it('flags a reflection citing NO evidence at all (ungrounded by definition)', () => {
        const reflection = makeReflection('ref_1', 'Astarion is immortal', [1, 0, 0], {
            source_ids: [],
            parent_ids: [],
        });
        const allMemories = [reflection];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(false);
        expect(result.reason).toBe('no_cited_evidence');
        expect(result.maxSimilarity).toBe(0);
        expect(result.checkedEvidenceIds).toEqual([]);
    });

    it('flags a reflection with undefined source_ids and parent_ids', () => {
        const reflection = makeReflection('ref_1', 'Astarion is immortal', [1, 0, 0]);
        const allMemories = [reflection];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(false);
        expect(result.reason).toBe('no_cited_evidence');
    });

    it('skips cited evidence whose embedding is missing (does not treat absence as distance)', () => {
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['evt_missing', 'evt_present'],
        });
        const allMemories = [
            makeMemory('evt_missing', 'no embedding here', null),
            makeMemory('evt_present', 'Astarion preened', [0.95, 0.31, 0]), // cos ≈ 0.95
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(true);
        expect(result.checkedEvidenceIds).toEqual(['evt_present']);
        expect(result.missingEvidenceIds).toEqual(['evt_missing']);
    });

    it('returns indeterminate (grounded) when ALL cited evidence lacks embeddings', () => {
        // Never false-positive on missing data.
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['evt_1', 'evt_2'],
        });
        const allMemories = [
            makeMemory('evt_1', 'no embedding', null),
            makeMemory('evt_2', 'also no embedding', null),
            reflection,
        ];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.missingEvidenceIds).toEqual(['evt_1', 'evt_2']);
    });

    it('returns indeterminate (grounded) when the reflection itself lacks an embedding', () => {
        const reflection = makeReflection('ref_1', 'Astarion is vain', null, {
            source_ids: ['evt_1'],
        });
        const allMemories = [makeMemory('evt_1', 'Astarion preened', [0.95, 0.31, 0]), reflection];

        const result = checkReflectionGrounding(reflection, allMemories);

        expect(result.grounded).toBe(true);
        expect(result.reason).toBeNull();
    });

    it('respects a custom threshold', () => {
        const reflection = makeReflection('ref_1', 'Astarion is guarded', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        // cos([1,0,0], [0.5, 0.866, 0]) = 0.5
        const allMemories = [makeMemory('evt_1', 'Astarion deflected a personal question', [0.5, 0.866, 0]), reflection];

        expect(checkReflectionGrounding(reflection, allMemories, { threshold: 0.3 }).grounded).toBe(true);
        expect(checkReflectionGrounding(reflection, allMemories, { threshold: 0.6 }).grounded).toBe(false);
    });

    it('clamps threshold to [0, 1]', () => {
        const reflection = makeReflection('ref_1', 'A', [1, 0, 0], { source_ids: ['evt_1'] });
        const allMemories = [makeMemory('evt_1', 'B', [0, 1, 0]), reflection]; // cos 0

        // threshold -1 → clamped to 0 → 0 ≥ 0 → grounded
        expect(checkReflectionGrounding(reflection, allMemories, { threshold: -1 }).grounded).toBe(true);
        // threshold 5 → clamped to 1 → 0 ≥ 1 → false → ungrounded
        expect(checkReflectionGrounding(reflection, allMemories, { threshold: 5 }).grounded).toBe(false);
    });

    it('deduplicates evidence ids present in both source_ids and parent_ids', () => {
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['shared'],
            parent_ids: ['shared'],
        });
        const allMemories = [makeMemory('shared', 'Astarion preened', [0.95, 0.31, 0]), reflection];

        const result = checkReflectionGrounding(reflection, allMemories);

        // 'shared' appears once in checkedEvidenceIds, not twice.
        expect(result.checkedEvidenceIds).toEqual(['shared']);
    });

    it('returns indeterminate for null/undefined reflection', () => {
        expect(checkReflectionGrounding(null, []).grounded).toBe(true);
        expect(checkReflectionGrounding(undefined, []).grounded).toBe(true);
    });

    it('handles a missing/empty allMemories array', () => {
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['evt_1'],
        });

        // Cited id can't be resolved → all missing → indeterminate.
        const result = checkReflectionGrounding(reflection, []);

        expect(result.grounded).toBe(true);
        expect(result.missingEvidenceIds).toEqual(['evt_1']);
    });

    it('uses DEFAULT_REFLECTION_GROUNDING_THRESHOLD (0.3) by default', () => {
        expect(DEFAULT_REFLECTION_GROUNDING_THRESHOLD).toBe(0.3);
    });
});

describe('findUngroundedReflections', () => {
    it('returns only the reflections that failed grounding, in input order', () => {
        const grounded = makeReflection('ref_grounded', 'Astarion is vain', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        const ungrounded = makeReflection('ref_ungrounded', 'Astarion can fly', [1, 0, 0], {
            source_ids: ['evt_2'],
        });
        const allMemories = [
            makeMemory('evt_1', 'Astarion preened', [0.95, 0.31, 0]), // close to grounded
            makeMemory('evt_2', 'A battle scene', [0, 1, 0]), // unrelated to "can fly"
            grounded,
            ungrounded,
        ];

        const results = findUngroundedReflections([grounded, ungrounded], allMemories);

        expect(results).toHaveLength(1);
        expect(results[0].reflection.id).toBe('ref_ungrounded');
        expect(results[0].reason).toBe('low_grounding_similarity');
    });

    it('skips reflections already reviewed (_grounding_reviewed)', () => {
        const ungrounded = makeReflection('ref_1', 'Astarion can fly', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        ungrounded._grounding_reviewed = true;
        const allMemories = [makeMemory('evt_1', 'A battle', [0, 1, 0]), ungrounded];

        expect(findUngroundedReflections([ungrounded], allMemories)).toEqual([]);
    });

    it('includes reflections flagged for no_cited_evidence', () => {
        const noEvidence = makeReflection('ref_1', 'Astarion is immortal', [1, 0, 0], {
            source_ids: [],
            parent_ids: [],
        });
        const allMemories = [noEvidence];

        const results = findUngroundedReflections([noEvidence], allMemories);

        expect(results).toHaveLength(1);
        expect(results[0].reason).toBe('no_cited_evidence');
    });

    it('respects a custom threshold across the batch', () => {
        const reflection = makeReflection('ref_1', 'Astarion is guarded', [1, 0, 0], {
            source_ids: ['evt_1'],
        });
        const allMemories = [makeMemory('evt_1', 'deflected a question', [0.5, 0.866, 0]), reflection]; // cos 0.5

        expect(findUngroundedReflections([reflection], allMemories, { threshold: 0.3 })).toEqual([]);
        expect(findUngroundedReflections([reflection], allMemories, { threshold: 0.6 })).toHaveLength(1);
    });

    it('returns [] for empty input or non-array', () => {
        expect(findUngroundedReflections([], [])).toEqual([]);
        expect(findUngroundedReflections(null, [])).toEqual([]);
    });
});

describe('stampGroundingResult', () => {
    it('stamps grounding_similarity, grounding_flagged, and grounding_reason onto a grounded reflection', () => {
        const reflection = makeReflection('ref_1', 'Astarion is vain', [1, 0, 0]);
        const result = { grounded: true, maxSimilarity: 0.91, checkedEvidenceIds: ['evt_1'], missingEvidenceIds: [], reason: null };

        stampGroundingResult(reflection, result);

        expect(reflection.grounding_similarity).toBe(0.91);
        expect(reflection.grounding_flagged).toBe(false);
        expect(reflection.grounding_reason).toBeNull();
    });

    it('stamps a flag when the reflection is ungrounded', () => {
        const reflection = makeReflection('ref_1', 'Astarion can fly', [1, 0, 0]);
        const result = { grounded: false, maxSimilarity: 0.05, checkedEvidenceIds: ['evt_1'], missingEvidenceIds: [], reason: 'low_grounding_similarity' };

        stampGroundingResult(reflection, result);

        expect(reflection.grounding_flagged).toBe(true);
        expect(reflection.grounding_similarity).toBe(0.05);
        expect(reflection.grounding_reason).toBe('low_grounding_similarity');
    });

    it('is a no-op when reflection or result is missing', () => {
        stampGroundingResult(null, { grounded: true });
        stampGroundingResult({}, null);
        // No throw, no crash.
    });
});

/**
 * Build a minimal reflection object for testing.
 * @param {string} id
 * @param {string} summary
 * @param {number[]|null} embedding - Raw vector, or null to omit
 * @param {{ source_ids?: string[], parent_ids?: string[], level?: number }} [extra]
 */
function makeReflection(id, summary, embedding, extra = {}) {
    const r = {
        id,
        type: 'reflection',
        character: 'Astarion',
        summary,
        created_at: 1000,
        source_ids: extra.source_ids ?? [],
        parent_ids: extra.parent_ids ?? [],
        level: extra.level ?? 1,
    };
    if (embedding) r.embedding = embedding;
    return r;
}

/**
 * Build a minimal memory object (event or parent reflection) for testing.
 * @param {string} id
 * @param {string} summary
 * @param {number[]|null} embedding - Raw vector, or null to omit
 */
function makeMemory(id, summary, embedding) {
    const m = { id, type: id.startsWith('ref_') ? 'reflection' : 'event', summary };
    if (embedding) m.embedding = embedding;
    return m;
}