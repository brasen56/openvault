// @ts-check
/* global describe, it, expect, beforeEach, setupTestContext */
import { describe, expect, it, vi } from 'vitest';
import { setDeps } from '../../src/deps.js';
import { mergeEntities, reconcileCharacterIdentity } from '../../src/store/chat-data.js';

describe('mergeEntities', () => {
    let mockGraph;
    let mockContext;

    beforeEach(() => {
        mockGraph = {
            nodes: {},
            edges: {},
            _mergeRedirects: {},
            _edgesNeedingConsolidation: [],
        };

        mockContext = { chatMetadata: { openvault: { graph: mockGraph } } };

        setupTestContext({
            deps: { saveChatConditional: vi.fn().mockResolvedValue(undefined) },
        });
        setDeps({
            getContext: () => mockContext,
            saveChatConditional: vi.fn().mockResolvedValue(undefined),
        });
    });

    describe('validation', () => {
        it('rejects when source equals target', async () => {
            mockGraph.nodes.entity1 = { name: 'Entity 1' };

            const result = await mergeEntities('entity1', 'entity1', mockGraph);

            expect(result.success).toBe(false);
            expect(result.stChanges).toBeUndefined();
        });

        it('rejects when source does not exist', async () => {
            mockGraph.nodes.target = { name: 'Target' };

            const result = await mergeEntities('nonexistent', 'target', mockGraph);

            expect(result.success).toBe(false);
        });

        it('rejects when target does not exist', async () => {
            mockGraph.nodes.source = { name: 'Source' };

            const result = await mergeEntities('source', 'nonexistent', mockGraph);

            expect(result.success).toBe(false);
        });
    });

    describe('basic merge', () => {
        beforeEach(() => {
            mockGraph.nodes.source = {
                name: 'Source Entity',
                description: 'Source description',
                mentions: 5,
                aliases: ['alias1', 'alias2'],
                type: 'PERSON',
                _st_synced: true,
            };
            mockGraph.nodes.target = {
                name: 'Target Entity',
                description: 'Target description',
                mentions: 10,
                aliases: ['alias3'],
                type: 'PERSON',
                _st_synced: true,
            };
        });

        it('combines mentions', async () => {
            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.nodes.target.mentions).toBe(15);
        });

        it('merges aliases including source name', async () => {
            await mergeEntities('source', 'target', mockGraph);

            const targetAliases = mockGraph.nodes.target.aliases;
            expect(targetAliases).toContain('alias1');
            expect(targetAliases).toContain('alias2');
            expect(targetAliases).toContain('alias3');
            expect(targetAliases).toContain('Source Entity');
        });

        it('removes duplicate aliases', async () => {
            mockGraph.nodes.target.aliases = ['alias1'];

            await mergeEntities('source', 'target', mockGraph);

            const targetAliases = mockGraph.nodes.target.aliases;
            expect(targetAliases.filter((a) => a === 'alias1').length).toBe(1);
        });

        it('deletes source node', async () => {
            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.nodes.source).toBeUndefined();
        });

        it('clears target embedding fields', async () => {
            mockGraph.nodes.target.embedding = [4, 5, 6];
            mockGraph.nodes.target.embedding_b64 = 'base64data';

            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.nodes.target.embedding).toBeUndefined();
            expect(mockGraph.nodes.target.embedding_b64).toBeUndefined();
        });

        it('sets merge redirect', async () => {
            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph._mergeRedirects.source).toBe('target');
        });

        it('returns stChanges with toDelete for source node', async () => {
            const result = await mergeEntities('source', 'target', mockGraph);

            expect(result.success).toBe(true);
            expect(result.stChanges).toBeDefined();
            expect(result.stChanges.toDelete.length).toBeGreaterThan(0);
        });
    });

    describe('schema guard - _mergeRedirects', () => {
        it('initializes _mergeRedirects if missing', async () => {
            delete mockGraph._mergeRedirects;
            mockGraph.nodes.source = { name: 'Source', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.target = { name: 'Target', description: '', mentions: 1, aliases: [], type: 'PERSON' };

            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph._mergeRedirects).toBeDefined();
            expect(mockGraph._mergeRedirects.source).toBe('target');
        });
    });

    describe('redirect cascading', () => {
        it('updates existing redirects pointing to source', async () => {
            mockGraph.nodes.source = { name: 'Source', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.target = { name: 'Target', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.other = { name: 'Other', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph._mergeRedirects.other = 'source';

            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph._mergeRedirects.other).toBe('target');
        });
    });

    describe('edge rewriting', () => {
        beforeEach(() => {
            mockGraph.nodes.source = { name: 'Source', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.target = { name: 'Target', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.charlie = { name: 'Charlie', description: '', mentions: 1, aliases: [], type: 'PERSON' };

            mockGraph.edges.source__charlie = {
                source: 'source',
                target: 'charlie',
                weight: 3,
                description: 'Source knows Charlie',
                _st_synced: true,
            };
        });

        it('rewrites edges from source to target', async () => {
            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.edges.target__charlie).toBeDefined();
            expect(mockGraph.edges.target__charlie.weight).toBe(3);
            expect(mockGraph.edges.source__charlie).toBeUndefined();
        });
    });

    describe('edge collision', () => {
        beforeEach(() => {
            mockGraph.nodes.source = { name: 'Source', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.target = { name: 'Target', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.charlie = { name: 'Charlie', description: '', mentions: 1, aliases: [], type: 'PERSON' };

            mockGraph.edges.source__charlie = {
                source: 'source',
                target: 'charlie',
                weight: 3,
                description: 'Source knows Charlie',
                _st_synced: true,
            };
            mockGraph.edges.target__charlie = {
                source: 'target',
                target: 'charlie',
                weight: 5,
                description: 'Target knows Charlie',
                _st_synced: true,
            };
        });

        it('sums weights on collision', async () => {
            await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.edges.target__charlie.weight).toBe(8);
        });

        it('merges descriptions on collision', async () => {
            await mergeEntities('source', 'target', mockGraph);

            const desc = mockGraph.edges.target__charlie.description;
            expect(desc).toContain('Target knows Charlie');
            expect(desc).toContain('Source knows Charlie');
        });
    });

    describe('self-loop prevention', () => {
        it('deletes edge that would become self-loop', async () => {
            mockGraph.nodes.source = { name: 'Source', description: '', mentions: 1, aliases: [], type: 'PERSON' };
            mockGraph.nodes.target = { name: 'Target', description: '', mentions: 1, aliases: [], type: 'PERSON' };

            mockGraph.edges.source__target = {
                source: 'source',
                target: 'target',
                weight: 3,
                description: 'Source knows Target',
                _st_synced: true,
            };

            const result = await mergeEntities('source', 'target', mockGraph);

            expect(mockGraph.edges.source__target).toBeUndefined();
            expect(mockGraph.edges.target__target).toBeUndefined();
            expect(result.stChanges.toDelete.length).toBeGreaterThan(0);
        });
    });

    describe('reconciles name-keyed stores on a PERSON merge', () => {
        it('migrates memories, character_states, and reflection_state from source to target', async () => {
            const saveFn = vi.fn(async () => true);
            const data = {
                schema_version: 3,
                memories: [
                    { id: 'm1', characters_involved: ['Greg', 'User'], witnesses: ['Greg'] },
                    { id: 'm2', emotional_impact: { Greg: 'angry' } },
                    { id: 'r1', type: 'reflection', character: 'Greg', characters_involved: ['Greg'] },
                ],
                character_states: {
                    Greg: { name: 'Greg', current_emotion: 'angry', last_updated: 200, known_events: ['m1'] },
                    'Greg Williams': {
                        name: 'Greg Williams',
                        current_emotion: 'calm',
                        last_updated: 100,
                        known_events: ['m2'],
                    },
                },
                reflection_state: { Greg: { importance_sum: 12 }, 'Greg Williams': { importance_sum: 5 } },
                processed_message_ids: [],
                graph: {
                    nodes: {
                        greg: { name: 'Greg', type: 'PERSON', description: 'a man', mentions: 3, aliases: [] },
                        'greg williams': {
                            name: 'Greg Williams',
                            type: 'PERSON',
                            description: 'a tall man',
                            mentions: 5,
                            aliases: [],
                        },
                    },
                    edges: {},
                    _mergeRedirects: {},
                },
            };
            setupTestContext({ context: { chatMetadata: { openvault: data } }, deps: { saveChatConditional: saveFn } });

            const { mergeEntities: mergeImported } = await import('../../src/store/chat-data.js');
            const result = await mergeImported('greg', 'greg williams');

            expect(result.success).toBe(true);
            // Memories reassigned to the surviving display name
            expect(data.memories[0].characters_involved).toEqual(['Greg Williams', 'User']);
            expect(data.memories[0].witnesses).toEqual(['Greg Williams']);
            expect(data.memories[1].emotional_impact).toEqual({ 'Greg Williams': 'angry' });
            expect(data.memories[2].character).toBe('Greg Williams');
            // character_states folded together, source removed, newest emotion wins
            expect(data.character_states.Greg).toBeUndefined();
            expect(data.character_states['Greg Williams'].current_emotion).toBe('angry');
            expect(data.character_states['Greg Williams'].known_events).toEqual(['m2', 'm1']);
            // reflection_state importance summed, source removed
            expect(data.reflection_state.Greg).toBeUndefined();
            expect(data.reflection_state['Greg Williams'].importance_sum).toBe(17);
        });
    });

    describe('reconcileCharacterIdentity (unit)', () => {
        it('is a no-op when source and target are the same (case-insensitive)', () => {
            const data = { memories: [{ characters_involved: ['Alex'] }] };
            reconcileCharacterIdentity(data, 'Alex', 'alex');
            expect(data.memories[0].characters_involved).toEqual(['Alex']);
        });

        it('matches the source name case-insensitively but writes the exact target name', () => {
            const data = { memories: [{ characters_involved: ['greg', 'GREG'] }] };
            reconcileCharacterIdentity(data, 'Greg', 'Greg Williams');
            expect(data.memories[0].characters_involved).toEqual(['Greg Williams']);
        });

        it('does not overwrite an existing target emotion on the same event', () => {
            const data = { memories: [{ emotional_impact: { Greg: 'angry', 'Greg Williams': 'calm' } }] };
            reconcileCharacterIdentity(data, 'Greg', 'Greg Williams');
            expect(data.memories[0].emotional_impact).toEqual({ 'Greg Williams': 'calm' });
        });

        it('moves a source character_state entry when the target has none', () => {
            const data = {
                character_states: { Greg: { name: 'Greg', current_emotion: 'wary', known_events: ['e1'] } },
            };
            reconcileCharacterIdentity(data, 'Greg', 'Greg Williams');
            expect(data.character_states.Greg).toBeUndefined();
            expect(data.character_states['Greg Williams'].name).toBe('Greg Williams');
            expect(data.character_states['Greg Williams'].current_emotion).toBe('wary');
        });

        it('handles missing stores gracefully', () => {
            expect(() => reconcileCharacterIdentity({}, 'Greg', 'Greg Williams')).not.toThrow();
            expect(() => reconcileCharacterIdentity(null, 'Greg', 'Greg Williams')).not.toThrow();
        });

        it('concatenates canon notes onto the survivor and removes the source key', () => {
            const data = {
                canon_notes: {
                    Greg: [{ id: 'c1', text: 'never demands' }],
                    'Greg Williams': [{ id: 'c2', text: 'speaks formally' }],
                },
            };
            reconcileCharacterIdentity(data, 'Greg', 'Greg Williams');
            expect(data.canon_notes.Greg).toBeUndefined();
            expect(data.canon_notes['Greg Williams'].map((n) => n.id)).toEqual(['c2', 'c1']);
        });

        it('moves canon notes when the survivor has none yet', () => {
            const data = { canon_notes: { Greg: [{ id: 'c1', text: 'never demands' }] } };
            reconcileCharacterIdentity(data, 'Greg', 'Greg Williams');
            expect(data.canon_notes.Greg).toBeUndefined();
            expect(data.canon_notes['Greg Williams']).toHaveLength(1);
        });
    });

    describe('ST Vector Storage sync', () => {
        it('returns toSync for surviving target node after merge', async () => {
            const saveFn = vi.fn(async () => true);
            setupTestContext({
                context: {
                    chatMetadata: {
                        openvault: {
                            schema_version: 3,
                            memories: [],
                            character_states: {},
                            processed_message_ids: [],
                            graph: {
                                nodes: {
                                    alice: {
                                        name: 'Alice',
                                        type: 'PERSON',
                                        description: 'A young woman',
                                        mentions: 3,
                                        aliases: [],
                                    },
                                    bob: {
                                        name: 'Bob',
                                        type: 'PERSON',
                                        description: 'A tall man',
                                        mentions: 2,
                                        aliases: [],
                                        _st_synced: true,
                                    },
                                },
                                edges: {},
                                _mergeRedirects: {},
                            },
                        },
                    },
                },
                deps: { saveChatConditional: saveFn },
            });

            const { mergeEntities: mergeEntitiesImported } = await import('../../src/store/chat-data.js');
            const result = await mergeEntitiesImported('bob', 'alice');

            expect(result.success).toBe(true);
            expect(result.stChanges.toDelete).toBeDefined();
            expect(result.stChanges.toDelete.length).toBeGreaterThan(0);
            // The bug: toSync is missing for the surviving node
            expect(result.stChanges.toSync).toBeDefined();
            expect(result.stChanges.toSync.length).toBeGreaterThan(0);
        });

        it('queues rewritten edge for re-sync in toSync after merge', async () => {
            const saveFn = vi.fn(async () => true);
            const testGraph = {
                nodes: {
                    alice: {
                        name: 'Alice',
                        type: 'PERSON',
                        description: 'A young woman',
                        mentions: 3,
                        aliases: [],
                        _st_synced: true,
                    },
                    bob: {
                        name: 'Bob',
                        type: 'PERSON',
                        description: 'A tall man',
                        mentions: 2,
                        aliases: [],
                        _st_synced: true,
                    },
                    charlie: {
                        name: 'Charlie',
                        type: 'PERSON',
                        description: 'Quiet guy',
                        mentions: 1,
                        aliases: [],
                    },
                },
                edges: {
                    alice__charlie: {
                        source: 'alice',
                        target: 'charlie',
                        weight: 2,
                        description: 'Alice mentors Charlie',
                        _st_synced: true,
                    },
                },
                _mergeRedirects: {},
            };
            setupTestContext({
                context: {
                    chatMetadata: {
                        openvault: {
                            schema_version: 3,
                            memories: [],
                            character_states: {},
                            processed_message_ids: [],
                            graph: testGraph,
                        },
                    },
                },
                deps: { saveChatConditional: saveFn },
            });

            const { mergeEntities: mergeEntitiesImported } = await import('../../src/store/chat-data.js');
            const result = await mergeEntitiesImported('alice', 'bob');

            expect(result.success).toBe(true);
            // The rewritten edge bob__charlie must be in toSync
            // Note: edge ID format uses single underscore: edge_bob_charlie
            const edgeSync = result.stChanges.toSync.find((s) => s.text.includes('edge_bob_charlie'));
            expect(edgeSync).toBeDefined();
            expect(edgeSync.item).toBe(testGraph.edges.bob__charlie); // same object reference
        });
    });
});
