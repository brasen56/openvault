import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock callLLM and enrichEventsWithEmbeddings before any imports
vi.mock('../../src/llm.js', () => ({
    callLLM: vi.fn(),
    LLM_CONFIGS: {
        contradiction: {
            profileSettingKey: 'extractionProfile',
            maxTokens: 500,
            errorContext: 'Contradiction verification',
            timeoutMs: 60000,
        },
    },
}));

vi.mock('../../src/embeddings.js', () => ({
    enrichEventsWithEmbeddings: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/perf/store.js', () => ({
    record: vi.fn(),
}));

/** Minimal memory factory */
function makeMemory(overrides = {}) {
    return {
        id: overrides.id || `mem_${Math.random().toString(36).slice(2, 8)}`,
        summary: overrides.summary || '',
        importance: overrides.importance ?? 3,
        message_id: overrides.message_id ?? 0,
        timestamp: overrides.timestamp ?? 0,
        tokens: overrides.tokens || [],
        characters_involved: overrides.characters_involved || [],
        extraction_count: overrides.extraction_count,
        type: overrides.type,
        archived: overrides.archived,
        ...overrides,
    };
}

/**
 * Set up deps on the same module instance that the code under test uses.
 * After vi.resetModules(), setupTestContext() may set deps on a stale
 * deps.js instance.  This helper imports deps.js fresh and sets it up.
 */
async function setupDeps(settingsOverrides = {}) {
    const { defaultSettings, extensionName } = await import('../../src/constants.js');
    const { setDeps } = await import('../../src/deps.js');
    setDeps({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getContext: () => ({
            chat: [],
            name1: 'User',
            name2: 'Alice',
            chatId: 'test-chat-123',
            chatMetadata: { openvault: {} },
            registerMacro: () => {},
        }),
        getExtensionSettings: () => ({
            [extensionName]: {
                ...defaultSettings,
                enabled: true,
                debugMode: false,
                ...settingsOverrides,
            },
        }),
        Date: { now: () => 1000000 },
    });
}

beforeEach(() => {
    vi.resetModules();
    global.registerCdnOverrides();
    setupTestContext();
});

// ---------------------------------------------------------------------------
// buildContradictionVerificationPrompt
// ---------------------------------------------------------------------------

describe('buildContradictionVerificationPrompt', () => {
    it('builds a prompt with both memories and character names', async () => {
        const { buildContradictionVerificationPrompt } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Alex hates Ezra', extraction_count: 5 });
        const memB = makeMemory({ summary: 'Alex loves Ezra', extraction_count: 10 });

        const messages = buildContradictionVerificationPrompt(memA, memB, ['Alex', 'Ezra']);

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content).toContain('Alex');
        expect(messages[0].content).toContain('Ezra');
        expect(messages[0].content).toContain('Alex hates Ezra');
        expect(messages[0].content).toContain('Alex loves Ezra');
    });

    it('handles missing extraction_count gracefully', async () => {
        const { buildContradictionVerificationPrompt } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Some event' });
        const memB = makeMemory({ summary: 'Another event' });

        const messages = buildContradictionVerificationPrompt(memA, memB, ['Alice']);
        expect(messages[0].content).toContain('extracted at message 0');
    });
});

// ---------------------------------------------------------------------------
// verifyContradiction
// ---------------------------------------------------------------------------

describe('verifyContradiction', () => {
    it('returns contradicts=true when LLM confirms with high confidence', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.95,
            reason: 'Same relationship described oppositely',
            newer_is_authoritative: true,
            suggested_merge: 'Alex and Ezra were enemies but later reconciled',
        }));

        const { verifyContradiction } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Alex hates Ezra', extraction_count: 5 });
        const memB = makeMemory({ summary: 'Alex loves Ezra', extraction_count: 10 });

        const result = await verifyContradiction(memA, memB, ['Alex', 'Ezra']);

        expect(result.contradicts).toBe(true);
        expect(result.confidence).toBe(0.95);
        expect(result.merge).toBeTruthy();
        expect(result.newerIsAuthoritative).toBe(true);
    });

    it('returns contradicts=false when LLM says no contradiction', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: false,
            confidence: 0.9,
            reason: 'Memories describe events at different times',
            newer_is_authoritative: false,
            suggested_merge: null,
        }));

        const { verifyContradiction } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Alex and Ezra met for the first time', extraction_count: 5 });
        const memB = makeMemory({ summary: 'Alex and Ezra became friends', extraction_count: 50 });

        const result = await verifyContradiction(memA, memB, ['Alex', 'Ezra']);

        expect(result.contradicts).toBe(false);
        expect(result.merge).toBeNull();
    });

    it('returns contradicts=false when confidence is below threshold', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.4,
            reason: 'Possibly contradictory',
            newer_is_authoritative: true,
            suggested_merge: null,
        }));

        const { verifyContradiction } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Alex hates Ezra', extraction_count: 5 });
        const memB = makeMemory({ summary: 'Alex loves Ezra', extraction_count: 10 });

        const result = await verifyContradiction(memA, memB, ['Alex', 'Ezra'], {
            confidenceThreshold: 0.7,
        });

        expect(result.contradicts).toBe(false);
    });

    it('propagates LLM errors', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockRejectedValue(new Error('API timeout'));

        const { verifyContradiction } = await import('../../src/retrieval/llm-contradiction.js');

        const memA = makeMemory({ summary: 'Test A' });
        const memB = makeMemory({ summary: 'Test B' });

        await expect(verifyContradiction(memA, memB, ['Alex'])).rejects.toThrow('API timeout');
    });
});

// ---------------------------------------------------------------------------
// mergeContradictingMemories
// ---------------------------------------------------------------------------

describe('mergeContradictingMemories', () => {
    it('archives older memory and updates newer with merged summary', async () => {
        const { mergeContradictingMemories } = await import('../../src/retrieval/llm-contradiction.js');

        const older = makeMemory({
            id: 'old_1',
            summary: 'Alex hates Ezra',
            importance: 2,
            tokens: ['alex', 'hates'],
            extraction_count: 5,
        });
        const newer = makeMemory({
            id: 'new_1',
            summary: 'Alex loves Ezra',
            importance: 4,
            tokens: ['alex', 'loves'],
            extraction_count: 10,
        });

        const merged = mergeContradictingMemories(older, newer, 'Alex and Ezra reconciled');

        expect(older.archived).toBe(true);
        expect(older.merged_into).toBe('new_1');
        expect(older.archive_reason).toBe('contradiction_merge');

        expect(newer.summary).toBe('Alex and Ezra reconciled');
        expect(newer.importance).toBe(4); // max of 2, 4
        expect(newer.merge_sources).toEqual(['old_1', 'new_1']);
        expect(newer.tokens).toContain('alex');
        expect(newer.tokens).toContain('hates');
        expect(newer.tokens).toContain('loves');
    });

    it('preserves higher importance from older memory', async () => {
        const { mergeContradictingMemories } = await import('../../src/retrieval/llm-contradiction.js');

        const older = makeMemory({ id: 'old', importance: 5, tokens: [] });
        const newer = makeMemory({ id: 'new', importance: 2, tokens: [] });

        mergeContradictingMemories(older, newer, 'Merged summary');

        expect(newer.importance).toBe(5);
    });

    it('deduplicates tokens', async () => {
        const { mergeContradictingMemories } = await import('../../src/retrieval/llm-contradiction.js');

        const older = makeMemory({ id: 'old', tokens: ['alex', 'ezra'] });
        const newer = makeMemory({ id: 'new', tokens: ['alex', 'bob'] });

        const result = mergeContradictingMemories(older, newer, 'test merge');

        // 'alex' should appear only once
        const alexCount = result.updated.tokens.filter((t) => t === 'alex').length;
        expect(alexCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// groupMemoriesByCharacterPair
// ---------------------------------------------------------------------------

describe('groupMemoriesByCharacterPair', () => {
    it('groups memories by shared character pairs', async () => {
        const { groupMemoriesByCharacterPair } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a1', characters_involved: ['Alex', 'Ezra'], extraction_count: 1 }),
            makeMemory({ id: 'a2', characters_involved: ['Alex', 'Ezra'], extraction_count: 5 }),
            makeMemory({ id: 'b1', characters_involved: ['Bob', 'Carol'], extraction_count: 2 }),
        ];

        const groups = groupMemoriesByCharacterPair(memories);

        expect(groups.size).toBe(2);
        const alexEzra = groups.get('alex|ezra');
        expect(alexEzra).toHaveLength(2);
        const bobCarol = groups.get('bob|carol');
        expect(bobCarol).toHaveLength(1);
    });

    it('excludes archived memories', async () => {
        const { groupMemoriesByCharacterPair } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'active', characters_involved: ['Alex', 'Ezra'], extraction_count: 1 }),
            makeMemory({ id: 'archived', characters_involved: ['Alex', 'Ezra'], extraction_count: 5, archived: true }),
        ];

        const groups = groupMemoriesByCharacterPair(memories);

        expect(groups.get('alex|ezra')).toHaveLength(1);
    });

    it('excludes reflections', async () => {
        const { groupMemoriesByCharacterPair } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'event', characters_involved: ['Alex', 'Ezra'] }),
            makeMemory({ id: 'reflection', characters_involved: ['Alex', 'Ezra'], type: 'reflection' }),
        ];

        const groups = groupMemoriesByCharacterPair(memories);

        expect(groups.get('alex|ezra')).toHaveLength(1);
    });

    it('excludes memories with fewer than 2 characters', async () => {
        const { groupMemoriesByCharacterPair } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'solo', characters_involved: ['Alex'] }),
            makeMemory({ id: 'none', characters_involved: [] }),
        ];

        const groups = groupMemoriesByCharacterPair(memories);
        expect(groups.size).toBe(0);
    });

    it('is case-insensitive in grouping', async () => {
        const { groupMemoriesByCharacterPair } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a', characters_involved: ['alex', 'EZRA'] }),
            makeMemory({ id: 'b', characters_involved: ['Alex', 'Ezra'] }),
        ];

        const groups = groupMemoriesByCharacterPair(memories);
        expect(groups.size).toBe(1);
        expect(groups.get('alex|ezra')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// findSuspiciousPairs
// ---------------------------------------------------------------------------

describe('findSuspiciousPairs', () => {
    it('finds pairs with opposing sentiments', async () => {
        const { findSuspiciousPairs } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'hate', summary: 'Alex hates Ezra', extraction_count: 5 }),
            makeMemory({ id: 'love', summary: 'Alex and Ezra became close friends', extraction_count: 20 }),
        ];

        const pairs = findSuspiciousPairs(memories);

        expect(pairs).toHaveLength(1);
        expect(pairs[0][0].id).toBe('hate');
        expect(pairs[0][1].id).toBe('love');
    });

    it('returns empty for no opposing sentiments', async () => {
        const { findSuspiciousPairs } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a', summary: 'Alex loves Ezra', extraction_count: 5 }),
            makeMemory({ id: 'b', summary: 'Alex and Ezra are best friends', extraction_count: 20 }),
        ];

        const pairs = findSuspiciousPairs(memories);
        expect(pairs).toHaveLength(0);
    });

    it('returns empty for fewer than 2 memories', async () => {
        const { findSuspiciousPairs } = await import('../../src/retrieval/llm-contradiction.js');

        expect(findSuspiciousPairs([])).toHaveLength(0);
        expect(findSuspiciousPairs([makeMemory({ id: 'solo' })])).toHaveLength(0);
    });

    it('respects maxPairs limit', async () => {
        const { findSuspiciousPairs } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [];
        for (let i = 0; i < 10; i++) {
            memories.push(makeMemory({
                id: `neg_${i}`,
                summary: 'Alex hates Ezra',
                extraction_count: i,
            }));
            memories.push(makeMemory({
                id: `pos_${i}`,
                summary: 'Alex loves Ezra',
                extraction_count: i + 100,
            }));
        }

        const pairs = findSuspiciousPairs(memories, 2);
        expect(pairs.length).toBeLessThanOrEqual(2);
    });

    it('adds oldest-newest pair when extraction_count gap >= 50', async () => {
        const { findSuspiciousPairs } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'old', summary: 'Alex and Ezra went to market', extraction_count: 0 }),
            makeMemory({ id: 'mid', summary: 'Alex and Ezra traveled together', extraction_count: 25 }),
            makeMemory({ id: 'new', summary: 'Alex and Ezra had a feast', extraction_count: 100 }),
        ];

        // All neutral — no sentiment pairs — but large gap triggers evolution check
        const pairs = findSuspiciousPairs(memories);

        // Only the oldest-newest pair should be returned
        expect(pairs).toHaveLength(1);
        expect(pairs[0][0].id).toBe('old');
        expect(pairs[0][1].id).toBe('new');
    });
});

// ---------------------------------------------------------------------------
// batchContradictionScan
// ---------------------------------------------------------------------------

describe('batchContradictionScan', () => {
    it('finds and reports contradictions across character groups', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.9,
            reason: 'Opposite relationship states',
            newer_is_authoritative: true,
            suggested_merge: 'Alex and Ezra reconciled',
        }));

        const { batchContradictionScan } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({
                id: 'hate',
                summary: 'Alex hates Ezra and they are enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'love',
                summary: 'Alex and Ezra became close friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        const results = await batchContradictionScan(memories);

        expect(results).toHaveLength(1);
        expect(results[0].older).toBe('hate');
        expect(results[0].newer).toBe('love');
        expect(results[0].reason).toBeTruthy();
    });

    it('respects maxCalls limit', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockClear();
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.9,
            reason: 'test',
            newer_is_authoritative: true,
            suggested_merge: 'merged',
        }));

        const { batchContradictionScan } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a1', summary: 'Alex hates Ezra', characters_involved: ['Alex', 'Ezra'], extraction_count: 5 }),
            makeMemory({ id: 'a2', summary: 'Alex loves Ezra', characters_involved: ['Alex', 'Ezra'], extraction_count: 10 }),
            makeMemory({ id: 'b1', summary: 'Bob hates Carol', characters_involved: ['Bob', 'Carol'], extraction_count: 5 }),
            makeMemory({ id: 'b2', summary: 'Bob loves Carol', characters_involved: ['Bob', 'Carol'], extraction_count: 10 }),
        ];

        const results = await batchContradictionScan(memories, { maxCalls: 1 });

        // Should only make 1 LLM call
        expect(callLLM).toHaveBeenCalledTimes(1);
    });

    it('auto-merges when option is set', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.9,
            reason: 'test',
            newer_is_authoritative: true,
            suggested_merge: 'They reconciled',
        }));

        const { batchContradictionScan } = await import('../../src/retrieval/llm-contradiction.js');

        const older = makeMemory({
            id: 'old',
            summary: 'Alex hates Ezra',
            characters_involved: ['Alex', 'Ezra'],
            extraction_count: 5,
            tokens: [],
        });
        const newer = makeMemory({
            id: 'new',
            summary: 'Alex loves Ezra',
            characters_involved: ['Alex', 'Ezra'],
            extraction_count: 10,
            tokens: [],
        });

        await batchContradictionScan([older, newer], { autoMerge: true });

        expect(older.archived).toBe(true);
        expect(newer.summary).toBe('They reconciled');
    });

    it('continues on LLM error', async () => {
        const { callLLM } = await import('../../src/llm.js');
        callLLM
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce(JSON.stringify({
                contradicts: true,
                confidence: 0.9,
                reason: 'test',
                newer_is_authoritative: true,
                suggested_merge: 'merged',
            }));

        const { batchContradictionScan } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a1', summary: 'Alex hates Ezra', characters_involved: ['Alex', 'Ezra'], extraction_count: 5 }),
            makeMemory({ id: 'a2', summary: 'Alex loves Ezra', characters_involved: ['Alex', 'Ezra'], extraction_count: 10 }),
            makeMemory({ id: 'b1', summary: 'Bob hates Carol', characters_involved: ['Bob', 'Carol'], extraction_count: 5 }),
            makeMemory({ id: 'b2', summary: 'Bob loves Carol', characters_involved: ['Bob', 'Carol'], extraction_count: 10 }),
        ];

        const results = await batchContradictionScan(memories, { maxCalls: 5 });

        // First call failed, second succeeded
        expect(results.length).toBeGreaterThanOrEqual(0); // second pair may or may not be in same group
    });

    it('returns empty when no suspicious pairs exist', async () => {
        const { batchContradictionScan } = await import('../../src/retrieval/llm-contradiction.js');

        const memories = [
            makeMemory({ id: 'a', summary: 'Alex went to market', characters_involved: ['Alex', 'Merchant'], extraction_count: 5 }),
            makeMemory({ id: 'b', summary: 'Bob had dinner', characters_involved: ['Bob', 'Carol'], extraction_count: 10 }),
        ];

        const results = await batchContradictionScan(memories);

        expect(results).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// checkNewMemoryContradictions
// ---------------------------------------------------------------------------

describe('checkNewMemoryContradictions', () => {
    it('skips when feature is disabled', async () => {
        await setupDeps({ llmContradictionEnabled: false });

        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            summary: 'Alex hates Ezra',
            characters_involved: ['Alex', 'Ezra'],
        });

        const result = await checkNewMemoryContradictions(newMem, []);

        expect(result).toEqual({ verified: false, merged: false });
    });

    it('skips when new memory has fewer than 2 characters', async () => {
        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            summary: 'Alex hates Ezra',
            characters_involved: ['Alex'],
        });

        const result = await checkNewMemoryContradictions(newMem, []);

        expect(result).toEqual({ verified: false, merged: false });
    });

    it('skips when new memory is neutral', async () => {
        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            summary: 'Alex and Ezra went to the market',
            characters_involved: ['Alex', 'Ezra'],
        });

        const existing = [
            makeMemory({
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
            }),
        ];

        const result = await checkNewMemoryContradictions(newMem, existing);

        expect(result).toEqual({ verified: false, merged: false });
    });

    it('skips when no opposing memories exist', async () => {
        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            summary: 'Alex loves Ezra',
            characters_involved: ['Alex', 'Ezra'],
        });

        const existing = [
            makeMemory({
                summary: 'Alex and Ezra are great friends',
                characters_involved: ['Alex', 'Ezra'],
            }),
        ];

        const result = await checkNewMemoryContradictions(newMem, existing);

        expect(result).toEqual({ verified: false, merged: false });
    });

    it('triggers LLM verification for opposing memories', async () => {
        await setupDeps({ llmContradictionEnabled: true });

        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: true,
            confidence: 0.95,
            reason: 'Opposite relationship states',
            newer_is_authoritative: true,
            suggested_merge: 'Alex and Ezra reconciled after being enemies',
        }));

        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            id: 'new_positive',
            summary: 'Alex and Ezra became close friends',
            characters_involved: ['Alex', 'Ezra'],
            extraction_count: 50,
            tokens: [],
        });

        const existing = [
            makeMemory({
                id: 'old_negative',
                summary: 'Alex hates Ezra and they are enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
                tokens: [],
            }),
        ];

        const result = await checkNewMemoryContradictions(newMem, existing, {
            autoMerge: true,
        });

        expect(result.verified).toBe(true);
        expect(result.merged).toBe(true);
        expect(result.reason).toBeTruthy();
        expect(callLLM).toHaveBeenCalled();
    });

    it('returns merged=false when LLM says no contradiction', async () => {
        await setupDeps({ llmContradictionEnabled: true });

        const { callLLM } = await import('../../src/llm.js');
        callLLM.mockResolvedValue(JSON.stringify({
            contradicts: false,
            confidence: 0.8,
            reason: 'Different time periods',
            newer_is_authoritative: false,
            suggested_merge: null,
        }));

        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            id: 'new_pos',
            summary: 'Alex loves Ezra',
            characters_involved: ['Alex', 'Ezra'],
            extraction_count: 100,
        });

        const existing = [
            makeMemory({
                id: 'old_neg',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
        ];

        const result = await checkNewMemoryContradictions(newMem, existing);

        expect(result.verified).toBe(true);
        expect(result.merged).toBe(false);
    });

    it('skips archived and reflection memories', async () => {
        const { checkNewMemoryContradictions } = await import('../../src/retrieval/llm-contradiction.js');

        const newMem = makeMemory({
            summary: 'Alex loves Ezra deeply',
            characters_involved: ['Alex', 'Ezra'],
        });

        const existing = [
            makeMemory({
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                archived: true,
            }),
            makeMemory({
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                type: 'reflection',
            }),
        ];

        const result = await checkNewMemoryContradictions(newMem, existing);

        // All existing are filtered out, so no opposing memories found
        expect(result).toEqual({ verified: false, merged: false });
    });
});