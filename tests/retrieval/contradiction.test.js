import { describe, expect, it } from 'vitest';

/** Minimal memory factory */
function makeMemory(overrides = {}) {
    return {
        id: overrides.id || `mem_${Math.random().toString(36).slice(2, 8)}`,
        summary: overrides.summary || '',
        importance: overrides.importance ?? 3,
        message_id: overrides.message_id ?? 0,
        timestamp: overrides.timestamp ?? 0,
        tokens: overrides.tokens || [],
        characters_involved: overrides.characters_involved,
        extraction_count: overrides.extraction_count,
        ...overrides,
    };
}

describe('classifySentiment', () => {
    it('returns POSITIVE for a summary with positive relationship keywords', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Alex and Ezra became close friends and reconciled');
        expect(result.sentiment).toBe(Sentiment.POSITIVE);
        expect(result.positiveCount).toBeGreaterThan(0);
        expect(result.negativeCount).toBe(0);
    });

    it('returns NEGATIVE for a summary with negative relationship keywords', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Alex hates Ezra and they are bitter enemies');
        expect(result.sentiment).toBe(Sentiment.NEGATIVE);
        expect(result.negativeCount).toBeGreaterThan(0);
        expect(result.positiveCount).toBe(0);
    });

    it('returns NEUTRAL when no sentiment keywords are present', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Alex went to the market to buy some food');
        expect(result.sentiment).toBe(Sentiment.NEUTRAL);
    });

    it('returns NEUTRAL when both positive and negative keywords are present', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        // Mixed signal — can't determine dominant sentiment
        const result = classifySentiment('Alex loves and hates Ezra at the same time');
        expect(result.sentiment).toBe(Sentiment.NEUTRAL);
    });

    it('returns NEUTRAL for null/undefined/empty summary', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        expect(classifySentiment(null).sentiment).toBe(Sentiment.NEUTRAL);
        expect(classifySentiment(undefined).sentiment).toBe(Sentiment.NEUTRAL);
        expect(classifySentiment('').sentiment).toBe(Sentiment.NEUTRAL);
    });

    it('detects multi-word positive phrases like "made up"', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        // Note: avoid negative keywords like "argument" in the test string
        const result = classifySentiment('Alex and Ezra finally made up and reconciled');
        expect(result.sentiment).toBe(Sentiment.POSITIVE);
        expect(result.positiveCount).toBeGreaterThan(0);
    });

    it('detects multi-word negative phrases like "fell out"', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Alex and Ezra fell out over a misunderstanding');
        expect(result.sentiment).toBe(Sentiment.NEGATIVE);
        expect(result.negativeCount).toBeGreaterThan(0);
    });

    it('neutralizes a negated negative keyword ("no longer hates")', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        // "hates" is negated, so it should NOT register as negative
        expect(classifySentiment('Alex no longer hates Ezra').sentiment).not.toBe(Sentiment.NEGATIVE);
    });

    it('neutralizes a contraction-negated positive keyword ("doesn\'t trust")', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        expect(classifySentiment("Alex doesn't trust Ezra anymore").sentiment).not.toBe(Sentiment.POSITIVE);
    });

    it('neutralizes a negated positive keyword ("never became friends")', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        expect(classifySentiment('Alex and Ezra never became friends').sentiment).not.toBe(Sentiment.POSITIVE);
    });

    it('still classifies non-negated keywords normally', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        // Regression guard: a negator elsewhere must not suppress an unrelated keyword
        expect(classifySentiment('Alex hates Ezra').sentiment).toBe(Sentiment.NEGATIVE);
        expect(classifySentiment('There was no food, but Alex and Ezra are close friends').sentiment).toBe(
            Sentiment.POSITIVE
        );
    });

    it('handles Russian negation ("не доверяет" → negative, not positive)', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        // "доверяет" (trusts) is negated by "не"; the negative phrase "не доверяет" carries
        const result = classifySentiment('Алекс не доверяет Эзре');
        expect(result.sentiment).toBe(Sentiment.NEGATIVE);
    });
});

describe('detectContradictions', () => {
    it('suppresses older negative memory when newer positive memory exists for same pair', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'old_hostile',
                summary: 'Alex is hostile towards Ezra and they are bitter enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'new_friends',
                summary: 'Alex and Ezra reconciled and became close friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        const { suppressedIds, contradictions } = detectContradictions(memories);

        expect(suppressedIds).toContain('old_hostile');
        expect(suppressedIds).not.toContain('new_friends');
        expect(contradictions).toHaveLength(1);
        expect(contradictions[0].newer.id).toBe('new_friends');
        expect(contradictions[0].older.id).toBe('old_hostile');
    });

    it('suppresses older positive memory when newer negative memory exists', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'old_friends',
                summary: 'Alex and Ezra are the best of friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 10,
            }),
            makeMemory({
                id: 'new_enemies',
                summary: 'Alex betrayed Ezra and now they are bitter enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 25,
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);

        expect(suppressedIds).toContain('old_friends');
        expect(suppressedIds).not.toContain('new_enemies');
    });

    it('does not suppress memories about different character pairs', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'alex_ezra_hostile',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'bob_carol_friends',
                summary: 'Bob and Carol became great friends',
                characters_involved: ['Bob', 'Carol'],
                extraction_count: 20,
            }),
        ];

        const { suppressedIds, contradictions } = detectContradictions(memories);

        expect(suppressedIds).toHaveLength(0);
        expect(contradictions).toHaveLength(0);
    });

    it('does not suppress neutral memories', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'neutral',
                summary: 'Alex and Ezra went to the market',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'positive',
                summary: 'Alex and Ezra reconciled and became friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);

        // Neutral shouldn't conflict with positive
        expect(suppressedIds).toHaveLength(0);
    });

    it('handles memories without characters_involved', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({ id: 'no_chars', summary: 'Alex hates Ezra' }),
            makeMemory({ id: 'no_chars_2', summary: 'Alex loves Ezra' }),
        ];

        const { suppressedIds } = detectContradictions(memories);

        // No characters_involved = no groups = no suppression
        expect(suppressedIds).toHaveLength(0);
    });

    it('handles single memory (no contradictions possible)', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'solo',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
            }),
        ];

        const { suppressedIds, contradictions } = detectContradictions(memories);
        expect(suppressedIds).toHaveLength(0);
        expect(contradictions).toHaveLength(0);
    });

    it('handles empty array', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');
        const { suppressedIds, contradictions } = detectContradictions([]);
        expect(suppressedIds).toHaveLength(0);
        expect(contradictions).toHaveLength(0);
    });

    it('handles null input', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');
        const { suppressedIds, contradictions } = detectContradictions(null);
        expect(suppressedIds).toHaveLength(0);
        expect(contradictions).toHaveLength(0);
    });

    it('uses timestamp as recency fallback when extraction_count is missing', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'old_negative',
                summary: 'Alex hates Ezra intensely',
                characters_involved: ['Alex', 'Ezra'],
                timestamp: 1000,
                // no extraction_count
            }),
            makeMemory({
                id: 'new_positive',
                summary: 'Alex and Ezra are close friends now',
                characters_involved: ['Alex', 'Ezra'],
                timestamp: 5000,
                // no extraction_count
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);
        expect(suppressedIds).toContain('old_negative');
    });

    it('suppresses ALL memories of the losing sentiment, not just the oldest', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'hate_1',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'hate_2',
                summary: 'Alex is hostile towards Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 8,
            }),
            makeMemory({
                id: 'love_1',
                summary: 'Alex and Ezra became close friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);

        // Both negative memories should be suppressed
        expect(suppressedIds).toContain('hate_1');
        expect(suppressedIds).toContain('hate_2');
        expect(suppressedIds).not.toContain('love_1');
    });

    it('is case-insensitive for character names in grouping', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'old',
                summary: 'Alex hates Ezra',
                characters_involved: ['alex', 'EZRA'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'new',
                summary: 'Alex and Ezra are friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);
        expect(suppressedIds).toContain('old');
    });
});

describe('filterContradictions', () => {
    it('returns filtered array with older contradictions removed', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'hostile',
                summary: 'Alex hates Ezra and they are enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'friendly',
                summary: 'Alex and Ezra became close friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
            makeMemory({
                id: 'unrelated',
                summary: 'Bob went to the store',
                characters_involved: ['Bob', 'Storekeeper'],
                extraction_count: 15,
            }),
        ];

        const result = filterContradictions(memories);

        expect(result.map((m) => m.id)).not.toContain('hostile');
        expect(result.map((m) => m.id)).toContain('friendly');
        expect(result.map((m) => m.id)).toContain('unrelated');
    });

    it('returns all memories unchanged when no contradictions exist', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'memory_1',
                summary: 'Alex went to the market',
                characters_involved: ['Alex', 'Merchant'],
            }),
            makeMemory({
                id: 'memory_2',
                summary: 'Bob and Carol had dinner',
                characters_involved: ['Bob', 'Carol'],
            }),
        ];

        const result = filterContradictions(memories);
        expect(result).toHaveLength(2);
    });
});

describe('Contradiction detection — Russian keywords', () => {
    it('detects Russian positive sentiment', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Алекс и Эзра стали близкими друзьями');
        expect(result.sentiment).toBe(Sentiment.POSITIVE);
    });

    it('detects Russian negative sentiment', async () => {
        const { classifySentiment, Sentiment } = await import('../../src/retrieval/contradiction.js');
        const result = classifySentiment('Алекс ненавидит Эзру и они враги');
        expect(result.sentiment).toBe(Sentiment.NEGATIVE);
    });

    it('suppresses older Russian negative when newer Russian positive exists', async () => {
        const { detectContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'ru_old',
                summary: 'Алекс и Эзра — заклятые враги и ненавидят взаимно',
                characters_involved: ['Алекс', 'Эзра'],
                extraction_count: 3,
            }),
            makeMemory({
                id: 'ru_new',
                summary: 'Алекс и Эзра помирились и стали друзьями',
                characters_involved: ['Алекс', 'Эзра'],
                extraction_count: 15,
            }),
        ];

        const { suppressedIds } = detectContradictions(memories);
        expect(suppressedIds).toContain('ru_old');
        expect(suppressedIds).not.toContain('ru_new');
    });
});
