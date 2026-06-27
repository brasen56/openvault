import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORIES_KEY, PROCESSED_MESSAGES_KEY } from '../../src/constants.js';
import { getFingerprint } from '../../src/extraction/scheduler.js';
import { CURRENT_SCHEMA_VERSION, runSchemaMigrations } from '../../src/store/migrations/index.js';

describe('migration orchestrator', () => {
    describe('runSchemaMigrations', () => {
        it('returns false when no migration needed (already v2)', () => {
            const data = { schema_version: 2, memories: [], canon_notes: {} };
            const result = runSchemaMigrations(data, []);
            expect(result).toBe(false);
        });

        it('returns false when schema_version equals current', () => {
            const data = { schema_version: CURRENT_SCHEMA_VERSION };
            const result = runSchemaMigrations(data, []);
            expect(result).toBe(false);
        });

        it('treats missing schema_version as v1', () => {
            const data = { [PROCESSED_MESSAGES_KEY]: [0, 1, 2] };
            // Will fail until v2 migration is implemented
            expect(() => runSchemaMigrations(data, [])).not.toThrow();
        });
    });
});

describe('v2 migration', () => {
    let chat;

    beforeEach(() => {
        let ts = 1000000;
        chat = [
            { mes: 'Hello', is_user: true, send_date: String(ts++) },
            { mes: 'Hi', is_user: false, send_date: String(ts++) },
            { mes: 'Bye', is_user: true, send_date: String(ts++) },
        ];
    });

    it('migrates index-based processed_message_ids to fingerprints', () => {
        const data = {
            [PROCESSED_MESSAGES_KEY]: [0, 2],
        };
        runSchemaMigrations(data, chat);

        expect(data[PROCESSED_MESSAGES_KEY]).toContain(getFingerprint(chat[0]));
        expect(data[PROCESSED_MESSAGES_KEY]).toContain(getFingerprint(chat[2]));
        expect(data[PROCESSED_MESSAGES_KEY]).not.toContain(0);
        expect(data[PROCESSED_MESSAGES_KEY]).not.toContain(2);
    });

    it('converts embedding arrays to embedding_b64', () => {
        const data = {
            [MEMORIES_KEY]: [
                { id: 'm1', embedding: [0.1, 0.2, 0.3] },
                { id: 'm2', embedding_b64: 'existing' }, // already converted
            ],
            graph: {
                nodes: [{ name: 'Alice', embedding: [0.5, 0.6] }],
            },
            communities: {},
        };

        runSchemaMigrations(data, chat);

        expect(data[MEMORIES_KEY][0].embedding).toBeUndefined();
        expect(data[MEMORIES_KEY][0].embedding_b64).toBeTypeOf('string');
        expect(data[MEMORIES_KEY][1].embedding_b64).toBe('existing'); // unchanged
        expect(data.graph.nodes[0].embedding).toBeUndefined();
        expect(data.graph.nodes[0].embedding_b64).toBeTypeOf('string');
    });

    it('initializes missing graph/communities/graph_message_count/reflection_state', () => {
        const data = {};

        runSchemaMigrations(data, chat);

        expect(data.graph).toBeDefined();
        expect(data.communities).toBeDefined();
        expect(data.graph_message_count).toBe(0);
        expect(data.reflection_state).toEqual({});
    });

    it('sets schema_version to current', () => {
        const data = {};
        runSchemaMigrations(data, chat);
        expect(data.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('returns true when migrations applied', () => {
        const data = { [PROCESSED_MESSAGES_KEY]: [0] };
        const result = runSchemaMigrations(data, chat);
        expect(result).toBe(true);
    });

    it('returns false when no changes needed', () => {
        const data = { schema_version: 2, canon_notes: {} };
        const result = runSchemaMigrations(data, chat);
        expect(result).toBe(false);
    });
});

describe('v3 migration - backfill message_fingerprints', () => {
    const chat = [
        { send_date: '1000000', name: 'Alice', mes: 'Hello' },
        { send_date: '2000000', name: 'Bob', mes: 'World' },
        { send_date: '3000000', name: 'Alice', mes: 'Goodbye' },
    ];

    it('converts message_ids indices to message_fingerprints for existing memories', () => {
        const data = {
            schema_version: 2,
            memories: [
                { id: 'mem1', message_ids: [0, 1] },
                { id: 'mem2', message_ids: [2] },
                { id: 'mem3', message_ids: [] },
            ],
        };

        const result = runSchemaMigrations(data, chat);

        expect(result).toBe(true);
        // schema_version reaches CURRENT_SCHEMA_VERSION (v4 since the extraction_count backfill)
        expect(data.schema_version).toBe(CURRENT_SCHEMA_VERSION);
        expect(data.memories[0].message_fingerprints).toEqual(['1000000', '2000000']);
        expect(data.memories[1].message_fingerprints).toEqual(['3000000']);
        expect(data.memories[2].message_fingerprints).toEqual([]);
    });

    it('skips migration when already at CURRENT_SCHEMA_VERSION', () => {
        const data = {
            schema_version: CURRENT_SCHEMA_VERSION,
            memories: [{ id: 'mem1', message_ids: [0], message_fingerprints: ['1000000'], extraction_count: 1 }],
        };

        const result = runSchemaMigrations(data, chat);

        expect(result).toBe(false);
    });

    it('handles memories with missing message_ids', () => {
        const data = {
            schema_version: 2,
            memories: [
                { id: 'mem1' }, // no message_ids at all
            ],
        };

        const result = runSchemaMigrations(data, chat);

        expect(result).toBe(true);
        expect(data.memories[0].message_fingerprints).toEqual([]);
    });

    it('handles out-of-bounds indices gracefully', () => {
        const data = {
            schema_version: 2,
            memories: [
                { id: 'mem1', message_ids: [0, 99, 2] }, // index 99 doesn't exist
            ],
        };

        const result = runSchemaMigrations(data, chat);

        expect(result).toBe(true);
        expect(data.memories[0].message_fingerprints).toEqual(['1000000', '3000000']);
    });

    it('leaves message_ids intact for backward compatibility', () => {
        const data = {
            schema_version: 2,
            memories: [{ id: 'mem1', message_ids: [0] }],
        };

        runSchemaMigrations(data, chat);

        expect(data.memories[0].message_ids).toEqual([0]); // still there
    });
});

describe('v4 migration — extraction_count backfill', () => {
    it('backfills extraction_count from sequence for events', () => {
        // sequence = minMessageId * 1000 + index, so 50000 → message_id 50
        const data = {
            schema_version: 3,
            graph_message_count: 200,
            memories: [
                { id: 'e1', type: 'event', sequence: 50000, message_ids: [50, 51] },
                { id: 'e2', type: 'event', sequence: 120000, message_ids: [120] },
            ],
        };

        const result = runSchemaMigrations(data, []);

        expect(result).toBe(true);
        expect(data.memories[0].extraction_count).toBe(50);
        expect(data.memories[1].extraction_count).toBe(120);
    });

    it('clamps backfilled extraction_count to graph_message_count', () => {
        // sequence would yield 999 but graph_message_count is only 100
        const data = {
            schema_version: 3,
            graph_message_count: 100,
            memories: [{ id: 'e1', type: 'event', sequence: 999000 }],
        };

        runSchemaMigrations(data, []);

        expect(data.memories[0].extraction_count).toBe(100);
    });

    it('stamps reflections with graph_message_count (Date.now-based sequences are not message-derived)', () => {
        const data = {
            schema_version: 3,
            graph_message_count: 75,
            memories: [{ id: 'r1', type: 'reflection', sequence: Date.now() }],
        };

        runSchemaMigrations(data, []);

        expect(data.memories[0].extraction_count).toBe(75);
    });

    it('falls back to max(message_ids) when sequence is missing', () => {
        const data = {
            schema_version: 3,
            graph_message_count: 200,
            memories: [{ id: 'e1', type: 'event', message_ids: [10, 25, 17] }],
        };

        runSchemaMigrations(data, []);

        expect(data.memories[0].extraction_count).toBe(25);
    });

    it('does not overwrite memories that already have extraction_count', () => {
        const data = {
            schema_version: 3,
            graph_message_count: 200,
            memories: [{ id: 'e1', type: 'event', sequence: 50000, extraction_count: 42 }],
        };

        runSchemaMigrations(data, []);

        expect(data.memories[0].extraction_count).toBe(42); // untouched
    });

    it('bumps schema_version to 4', () => {
        const data = { schema_version: 3, memories: [] };
        runSchemaMigrations(data, []);
        // v4 runs the backfill; the orchestrator always advances to current (now 5).
        expect(data.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    });
});

describe('v5 migration — canon_notes initialization', () => {
    it('initializes canon_notes as an empty object when missing', () => {
        const data = { schema_version: 4, memories: [] };

        const result = runSchemaMigrations(data, []);

        expect(result).toBe(true);
        expect(data.canon_notes).toEqual({});
    });

    it('does not overwrite an existing canon_notes record', () => {
        const existing = { Alice: [{ id: 'canon_1', text: 'never demands' }] };
        const data = { schema_version: 4, memories: [], canon_notes: existing };

        const result = runSchemaMigrations(data, []);

        expect(result).toBe(false);
        expect(data.canon_notes).toBe(existing);
    });

    it('replaces a malformed canon_notes value with an empty object', () => {
        const data = { schema_version: 4, memories: [], canon_notes: 'oops' };

        runSchemaMigrations(data, []);

        expect(data.canon_notes).toEqual({});
    });

    it('bumps schema_version to 5', () => {
        const data = { schema_version: 4, memories: [] };
        runSchemaMigrations(data, []);
        expect(data.schema_version).toBe(5);
    });
});
