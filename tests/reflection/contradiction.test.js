import { beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD,
    buildReflectionContradictionPrompt,
    driftPairKey,
    findContradictionCandidates,
    isDriftPairAnalyzed,
    recordDriftPairAnalyzed,
    resolveDriftWarning,
} from '../../src/reflection/contradiction.js';

describe('findContradictionCandidates', () => {
    beforeEach(() => {
        setupTestContext();
    });

    it('flags pairs in the candidate band (threshold ≤ sim < dupBand)', () => {
        // cos([1,0,0], [0.6, 0.8, 0]) = 0.6 — in the 0.45–0.72 band
        const reflections = [
            makeReflection('ref_a', 'Astarion trusts the party', [1, 0, 0]),
            makeReflection('ref_b', 'Astarion refuses to be vulnerable', [0.6, 0.8, 0]),
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(1);
        expect(pairs[0].cosineSim).toBeCloseTo(0.6, 2);
    });

    it('does not flag pairs below the threshold', () => {
        // cos([1,0,0], [0,1,0]) = 0 — below 0.45
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            makeReflection('ref_b', 'B', [0, 1, 0]),
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('does not flag pairs at or above the dupe band (Phase 1 territory)', () => {
        // cos([1,0,0], [0.95, 0.31, 0]) = 0.95 — above 0.72, that's a near-dupe
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            makeReflection('ref_b', 'B', [0.95, 0.31, 0]),
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('respects a custom threshold and dup band', () => {
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            // 0.5 cosine — flagged at 0.45/dupBand 0.72, not at 0.6/dupBand 0.72
            makeReflection('ref_b', 'B', [0.5, 0.87, 0]),
        ];

        expect(findContradictionCandidates(reflections, { threshold: 0.45 })).toHaveLength(1);
        expect(findContradictionCandidates(reflections, { threshold: 0.6 })).toHaveLength(0);
    });

    it('clamps threshold to [0, 1]', () => {
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            makeReflection('ref_b', 'B', [0.6, 0.8, 0]),
        ];

        // Below 0 → treated as 0 → flags (0.6 ≥ 0), but default dupBand 0.72 still excludes
        expect(findContradictionCandidates(reflections, { threshold: -1 })).toHaveLength(1);
        // Above 1 → treated as 1 → nothing flagged
        expect(findContradictionCandidates(reflections, { threshold: 5 })).toHaveLength(0);
    });

    it('skips reflections without an embedding (no crash)', () => {
        const reflections = [
            makeReflection('ref_a', 'Has embedding', [1, 0, 0]),
            makeReflection('ref_no_emb', 'No embedding', null),
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('skips pairs already resolved (_drift_reviewed on both)', () => {
        const reflections = [
            { ...makeReflection('ref_a', 'A', [1, 0, 0]), _drift_reviewed: true },
            { ...makeReflection('ref_b', 'B', [0.6, 0.8, 0]), _drift_reviewed: true },
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(0);
    });

    it('sorts most-similar first (closest to dup band)', () => {
        // Three reflections: A-B ≈ 0.6, A-C ≈ 0.5, B-C ≈ 0.6.
        // All in the band. Sorted most-similar first.
        const reflections = [
            makeReflection('ref_a', 'A', [1, 0, 0]),
            makeReflection('ref_b', 'B', [0.6, 0.8, 0]), // cos with A ≈ 0.6
            makeReflection('ref_c', 'C', [0.5, 0.87, 0]), // cos with A ≈ 0.5, with B ≈ 0.91 (above dup band, excluded)
        ];

        const pairs = findContradictionCandidates(reflections);

        // A-B ≈ 0.6 (in band), A-C ≈ 0.5 (in band), B-C ≈ 0.91 (above dupBand, excluded)
        expect(pairs.length).toBeGreaterThanOrEqual(1);
        // Most-similar first
        for (let i = 1; i < pairs.length; i++) {
            expect(pairs[i - 1].cosineSim).toBeGreaterThanOrEqual(pairs[i].cosineSim);
        }
    });

    it('orders the pair so `a` is the earlier reflection when created_at is known', () => {
        const reflections = [
            { ...makeReflection('ref_newer', 'newer', [0.6, 0.8, 0]), created_at: 2000 },
            { ...makeReflection('ref_older', 'older', [1, 0, 0]), created_at: 1000 },
        ];

        const pairs = findContradictionCandidates(reflections);

        expect(pairs).toHaveLength(1);
        expect(pairs[0].a.id).toBe('ref_older');
        expect(pairs[0].b.id).toBe('ref_newer');
    });

    it('returns [] for empty or single-element input', () => {
        expect(findContradictionCandidates([])).toEqual([]);
        expect(findContradictionCandidates([makeReflection('only', 'x', [1, 0, 0])])).toEqual([]);
    });

    it('uses DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD when no threshold given', () => {
        expect(DEFAULT_REFLECTION_CONTRADICTION_CANDIDATE_THRESHOLD).toBe(0.45);
    });
});

describe('driftPairKey / isDriftPairAnalyzed / recordDriftPairAnalyzed', () => {
    it('produces a stable, order-independent key prefixed with rdrift:', () => {
        const a = makeReflection('ref_a', 'trusts the party', [1, 0, 0]);
        const b = makeReflection('ref_b', 'refuses to be vulnerable', [0.6, 0.8, 0]);

        const keyAB = driftPairKey(a, b);
        const keyBA = driftPairKey(b, a);

        expect(keyAB).toBe(keyBA);
        expect(keyAB.startsWith('rdrift:')).toBe(true);
    });

    it('self-invalidates when a summary changes', () => {
        const a = makeReflection('ref_a', 'trusts the party', [1, 0, 0]);
        const b = makeReflection('ref_b', 'refuses to be vulnerable', [0.6, 0.8, 0]);

        const keyOriginal = driftPairKey(a, b);

        // Edit the summary on `a`
        const aEdited = { ...a, summary: 'trusts everyone unconditionally' };
        const keyEdited = driftPairKey(aEdited, b);

        expect(keyOriginal).not.toBe(keyEdited);
    });

    it('isDriftPairAnalyzed returns false for empty/null cache', () => {
        const a = makeReflection('ref_a', 'A', [1, 0, 0]);
        const b = makeReflection('ref_b', 'B', [0.6, 0.8, 0]);

        expect(isDriftPairAnalyzed(null, a, b)).toBe(false);
        expect(isDriftPairAnalyzed(undefined, a, b)).toBe(false);
        expect(isDriftPairAnalyzed({}, a, b)).toBe(false);
    });

    it('recordDriftPairAnalyzed marks the pair as analyzed', () => {
        const a = makeReflection('ref_a', 'A', [1, 0, 0]);
        const b = makeReflection('ref_b', 'B', [0.6, 0.8, 0]);
        const cache = {};

        expect(isDriftPairAnalyzed(cache, a, b)).toBe(false);

        recordDriftPairAnalyzed(cache, a, b);

        expect(isDriftPairAnalyzed(cache, a, b)).toBe(true);
        expect(isDriftPairAnalyzed(cache, b, a)).toBe(true); // order-independent
    });

    it('does not share keys with the event-oriented cache (no collision)', () => {
        const a = makeReflection('ref_a', 'A', [1, 0, 0]);
        const b = makeReflection('ref_b', 'B', [0.6, 0.8, 0]);

        const key = driftPairKey(a, b);
        // Event cache keys look like "id:hash|id:hash" (no prefix). Drift keys
        // are prefixed "rdrift:" so they can't collide in a shared map.
        expect(key.startsWith('rdrift:')).toBe(true);
    });
});

describe('buildReflectionContradictionPrompt', () => {
    it('includes both reflections, the character name, and timestamps', () => {
        const a = {
            ...makeReflection('ref_a', 'Astarion refuses to be vulnerable', [1, 0, 0]),
            created_at: 1000,
            extraction_count: 50,
        };
        const b = {
            ...makeReflection('ref_b', 'Astarion trusts the party', [0.6, 0.8, 0]),
            created_at: 2000,
            extraction_count: 150,
        };

        const messages = buildReflectionContradictionPrompt(a, b, 'Astarion');

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');

        const content = messages[0].content;
        expect(content).toContain('Astarion');
        expect(content).toContain('Astarion refuses to be vulnerable');
        expect(content).toContain('Astarion trusts the party');
        expect(content).toContain('50'); // extraction_count of A
        expect(content).toContain('150'); // extraction_count of B
        expect(content).toContain('1000'); // created_at of A
        expect(content).toContain('2000'); // created_at of B
    });

    it('instructs the verifier on drift vs development vs consistent', () => {
        const a = makeReflection('ref_a', 'A', [1, 0, 0]);
        const b = makeReflection('ref_b', 'B', [0.6, 0.8, 0]);

        const content = buildReflectionContradictionPrompt(a, b, 'Test')[0].content;

        expect(content).toContain('DRIFT');
        expect(content).toContain('DEVELOPMENT');
        expect(content).toContain('CONSISTENT');
        // The prompt must distinguish drift (conflicting present-tense) from
        // development (old state superseded by new).
        expect(content).toContain('mutually exclusive');
        expect(content).toContain('supersedes');
    });

    it('does NOT contain the event pipeline\'s "development, not contradiction" suppression', () => {
        // The event pipeline prompt says "A relationship changing over time
        // (enemies → friends) is NOT a contradiction — it is character development."
        // The drift prompt must NOT include that blanket suppression — it would
        // suppress exactly the conflicts we want to surface.
        const a = makeReflection('ref_a', 'A', [1, 0, 0]);
        const b = makeReflection('ref_b', 'B', [0.6, 0.8, 0]);

        const content = buildReflectionContradictionPrompt(a, b, 'Test')[0].content;

        expect(content).not.toContain('enemies → friends');
        expect(content).not.toContain('NOT a contradiction');
    });
});

describe('resolveDriftWarning', () => {
    it('archives the absorbed reflection and unions evidence onto the survivor', () => {
        const survivor = makeReflection('ref_survivor', 'trusts the party', [1, 0, 0]);
        survivor.source_ids = ['evt_1', 'evt_2'];
        survivor.parent_ids = ['ref_parent_1'];
        const absorbed = makeReflection('ref_absorbed', 'refuses to be vulnerable', [0.6, 0.8, 0]);
        absorbed.source_ids = ['evt_2', 'evt_3'];
        absorbed.parent_ids = ['ref_parent_2'];

        resolveDriftWarning(survivor, absorbed);

        expect(survivor.source_ids).toEqual(['evt_1', 'evt_2', 'evt_3']);
        expect(survivor.parent_ids).toEqual(['ref_parent_1', 'ref_parent_2']);
        expect(absorbed.archived).toBe(true);
        expect(absorbed.archive_reason).toBe('drift_contradiction');
        expect(absorbed.merged_into).toBe('ref_survivor');
        expect(absorbed._drift_reviewed).toBe(true);
        expect(survivor._drift_reviewed).toBe(true);
    });

    it('applies canon text to the survivor when provided', () => {
        const survivor = makeReflection('ref_survivor', 'trusts the party', [1, 0, 0]);
        const absorbed = makeReflection('ref_absorbed', 'refuses to be vulnerable', [0.6, 0.8, 0]);

        resolveDriftWarning(survivor, absorbed, 'Astarion is guarded but learning to trust close allies');

        expect(survivor.summary).toBe('Astarion is guarded but learning to trust close allies');
    });

    it('keeps the survivor summary when no canon text is provided', () => {
        const survivor = makeReflection('ref_survivor', 'trusts the party', [1, 0, 0]);
        const absorbed = makeReflection('ref_absorbed', 'refuses to be vulnerable', [0.6, 0.8, 0]);

        resolveDriftWarning(survivor, absorbed);

        expect(survivor.summary).toBe('trusts the party');
    });

    it('ignores empty/whitespace canon text', () => {
        const survivor = makeReflection('ref_survivor', 'trusts the party', [1, 0, 0]);
        const absorbed = makeReflection('ref_absorbed', 'refuses to be vulnerable', [0.6, 0.8, 0]);

        resolveDriftWarning(survivor, absorbed, '   ');

        expect(survivor.summary).toBe('trusts the party');
    });

    it('handles missing source_ids / parent_ids gracefully', () => {
        const survivor = makeReflection('ref_s', 's', [1, 0, 0]);
        const absorbed = makeReflection('ref_a', 'a', [0.6, 0.8, 0]);

        resolveDriftWarning(survivor, absorbed);

        expect(survivor.source_ids).toEqual([]);
        expect(survivor.parent_ids).toEqual([]);
        expect(absorbed.archived).toBe(true);
    });

    it('is a no-op when either argument is missing or they are the same', () => {
        const r = makeReflection('ref_x', 'x', [1, 0, 0]);

        resolveDriftWarning(null, r);
        resolveDriftWarning(r, null);
        resolveDriftWarning(r, r);

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