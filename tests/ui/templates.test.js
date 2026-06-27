import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
    renderCharacterDossier,
    renderCommunityAccordion,
    renderEntityCard,
    renderMemoryItem,
    renderReflectionProgress,
} from '../../src/ui/templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read settings panel HTML for template validation
const settingsPanelHtml = readFileSync(join(__dirname, '../../templates/settings_panel.html'), 'utf-8');

describe('ui/templates', () => {
    describe('renderMemoryItem', () => {
        it('includes reflection badge for reflection memories', () => {
            const memory = {
                id: 'ref_001',
                type: 'reflection',
                summary: 'Alice has grown suspicious',
                importance: 4,
                characters_involved: ['Alice'],
                source_ids: ['ev_001', 'ev_002', 'ev_003'],
                created_at: Date.now(),
            };
            const html = renderMemoryItem(memory);
            expect(html).toContain('fa-lightbulb');
            expect(html).toContain('Reflection');
        });

        it('includes evidence count for reflection with source_ids', () => {
            const memory = {
                id: 'ref_001',
                type: 'reflection',
                summary: 'Alice has grown suspicious',
                importance: 4,
                characters_involved: ['Alice'],
                source_ids: ['ev_001', 'ev_002', 'ev_003'],
                created_at: Date.now(),
            };
            const html = renderMemoryItem(memory);
            expect(html).toContain('3 evidence');
        });

        it('does not include reflection badge for regular events', () => {
            const memory = {
                id: 'ev_001',
                summary: 'Alice entered the room',
                importance: 3,
                characters_involved: ['Alice'],
                created_at: Date.now(),
            };
            const html = renderMemoryItem(memory);
            expect(html).not.toContain('fa-lightbulb');
            expect(html).not.toContain('Reflection');
        });
    });

    describe('renderReflectionProgress', () => {
        it('renders counters for each character', () => {
            const state = {
                'King Aldric': { importance_sum: 22 },
                'Royal Guard': { importance_sum: 8 },
            };
            const html = renderReflectionProgress(state, 30);
            expect(html).toContain('King Aldric: 22/30');
            expect(html).toContain('Royal Guard: 8/30');
        });

        it('sorts characters alphabetically', () => {
            const state = {
                Zelda: { importance_sum: 10 },
                Alice: { importance_sum: 5 },
            };
            const html = renderReflectionProgress(state, 30);
            const aliceIdx = html.indexOf('Alice');
            const zeldaIdx = html.indexOf('Zelda');
            expect(aliceIdx).toBeLessThan(zeldaIdx);
        });

        it('returns placeholder for empty state', () => {
            const html = renderReflectionProgress({}, 30);
            expect(html).toContain('No reflection data yet');
        });

        it('returns placeholder for null state', () => {
            const html = renderReflectionProgress(null, 30);
            expect(html).toContain('No reflection data yet');
        });

        it('defaults importance_sum to 0', () => {
            const state = { Alice: {} };
            const html = renderReflectionProgress(state, 30);
            expect(html).toContain('Alice: 0/30');
        });
    });

    describe('renderCommunityAccordion', () => {
        it('renders community title and member count', () => {
            const community = {
                title: 'The Royal Court',
                summary: 'King Aldric rules from the Castle.',
                findings: ['The King is powerful', 'The Guard is loyal'],
                nodeKeys: ['king aldric', 'castle', 'royal guard'],
            };
            const html = renderCommunityAccordion('C0', community);
            expect(html).toContain('The Royal Court');
            expect(html).toContain('3 entities');
        });

        it('renders summary and findings', () => {
            const community = {
                title: 'Court',
                summary: 'A powerful court.',
                findings: ['Finding one', 'Finding two'],
                nodeKeys: ['a'],
            };
            const html = renderCommunityAccordion('C0', community);
            expect(html).toContain('A powerful court.');
            expect(html).toContain('Finding one');
            expect(html).toContain('Finding two');
            expect(html).toContain('<li>');
        });

        it('renders member list', () => {
            const community = {
                title: 'Test',
                summary: 'Test',
                findings: [],
                nodeKeys: ['alice', 'bob'],
            };
            const html = renderCommunityAccordion('C0', community);
            expect(html).toContain('alice');
            expect(html).toContain('bob');
        });

        it('uses community ID as fallback title', () => {
            const community = { summary: 'No title', findings: [], nodeKeys: [] };
            const html = renderCommunityAccordion('C5', community);
            expect(html).toContain('C5');
        });

        it('handles empty findings', () => {
            const community = { title: 'Test', summary: 'Test', findings: [], nodeKeys: [] };
            const html = renderCommunityAccordion('C0', community);
            expect(html).not.toContain('<ul');
        });

        it('shows 0 entities for empty nodeKeys', () => {
            const community = { title: 'Test', summary: 'Test', findings: [], nodeKeys: [] };
            const html = renderCommunityAccordion('C0', community);
            expect(html).toContain('0 entities');
        });
    });

    describe('renderEntityCard', () => {
        it('renders entity name and type badge', () => {
            const entity = { name: 'King Aldric', type: 'PERSON', description: 'The aging ruler', mentions: 7 };
            const html = renderEntityCard(entity, 'king_aldric');
            expect(html).toContain('King Aldric');
            expect(html).toContain('person'); // lowercase class
            expect(html).toContain('data-key="king_aldric"');
        });

        it('renders mention count', () => {
            const entity = { name: 'Castle', type: 'PLACE', description: 'Ancient fortress', mentions: 3 };
            const html = renderEntityCard(entity, 'castle');
            expect(html).toContain('3 mentions');
        });

        it('renders description', () => {
            const entity = { name: 'Castle', type: 'PLACE', description: 'Ancient fortress', mentions: 1 };
            const html = renderEntityCard(entity, 'castle');
            expect(html).toContain('Ancient fortress');
        });

        it('handles missing description', () => {
            const entity = { name: 'Castle', type: 'PLACE', mentions: 1 };
            const html = renderEntityCard(entity, 'castle');
            expect(html).toContain('Castle');
        });

        it('defaults mentions to 0', () => {
            const entity = { name: 'Castle', type: 'PLACE', description: '' };
            const html = renderEntityCard(entity, 'castle');
            expect(html).toContain('0 mentions');
        });
    });

    describe('renderCharacterDossier', () => {
        const buildDossier = () => ({
            name: 'Alice',
            state: {
                name: 'Alice',
                emotion: 'wary',
                emotionSource: ' (msg 3)',
                intensity: 7,
                intensityPercent: 70,
                knownCount: 2,
            },
            reflectionsByLevel: [
                {
                    level: 2,
                    reflections: [
                        {
                            id: 'ref_2',
                            summary: 'Alice is guarded but adaptive',
                            importance: 5,
                            level: 2,
                            source_ids: [],
                            parent_ids: ['ref_1'],
                            evidence: [
                                {
                                    id: 'ref_1',
                                    type: 'reflection',
                                    summary: 'Alice communicates in sign language',
                                    importance: 4,
                                    level: 1,
                                },
                            ],
                        },
                    ],
                },
                {
                    level: 1,
                    reflections: [
                        {
                            id: 'ref_1',
                            summary: 'Alice relies on sign language',
                            importance: 4,
                            level: 1,
                            source_ids: ['e1'],
                            parent_ids: [],
                            evidence: [
                                { id: 'e1', type: 'event', summary: 'Alice signed instead of speaking', importance: 3 },
                            ],
                        },
                    ],
                },
            ],
            reflectionCount: 2,
            relationships: [{ name: 'Bob', key: 'bob', description: 'trusts cautiously', weight: 3 }],
            progress: { importanceSum: 30, threshold: 40, percent: 75, ready: false },
        });

        it('renders reflection progress with sum, threshold, and percent bar', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('30/40');
            expect(html).toContain('width: 75%');
        });

        it('shows a Ready badge when progress is ready', () => {
            const dossier = buildDossier();
            dossier.progress = { importanceSum: 50, threshold: 40, percent: 100, ready: true };
            const html = renderCharacterDossier(dossier);
            expect(html).toContain('Ready');
        });

        it('groups reflections by level descending with level badges', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('L2');
            expect(html).toContain('L1');
            // The headline (level-2) reflection renders before the level-1 specific
            const headlineIdx = html.indexOf('guarded but adaptive');
            const specificIdx = html.indexOf('relies on sign language');
            expect(headlineIdx).toBeGreaterThan(-1);
            expect(specificIdx).toBeGreaterThan(-1);
            expect(headlineIdx).toBeLessThan(specificIdx);
        });

        it('renders importance stars on reflections', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('★★★★★'); // importance 5 on the headline reflection
        });

        it('renders an evidence drill-down with the backing summaries', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('<details');
            expect(html).toContain('Evidence');
            expect(html).toContain('Alice signed instead of speaking');
        });

        it('flags deleted (missing) evidence', () => {
            const dossier = buildDossier();
            dossier.reflectionsByLevel[1].reflections[0].evidence = [{ id: 'e1', missing: true }];
            const html = renderCharacterDossier(dossier);
            expect(html).toContain('Deleted memory');
            expect(html).toContain('e1');
        });

        it('renders relationships with name and description', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('Bob');
            expect(html).toContain('trusts cautiously');
        });

        it('shows placeholders for empty reflections and relationships', () => {
            const html = renderCharacterDossier({
                reflectionsByLevel: [],
                relationships: [],
                progress: { importanceSum: 0, threshold: 40, percent: 0, ready: false },
            });
            expect(html).toContain('No insights yet');
            expect(html).toContain('No relationships recorded');
        });

        it('HTML-escapes reflection summaries and relationship descriptions', () => {
            const dossier = buildDossier();
            dossier.reflectionsByLevel[0].reflections[0].summary = '<script>alert(1)</script>';
            dossier.relationships = [{ name: 'Bob', key: 'bob', description: 'a & b', weight: 1 }];
            const html = renderCharacterDossier(dossier);
            expect(html).not.toContain('<script>alert(1)</script>');
            expect(html).toContain('&amp;');
        });

        it('does not throw for a null dossier', () => {
            expect(() => renderCharacterDossier(null)).not.toThrow();
        });
        it('renders a mark-wrong button on each reflection card', () => {
            const html = renderCharacterDossier(buildDossier());
            expect(html).toContain('data-action="dossier-mark-wrong"');
        });

        it('renders the canon notes editor with existing notes', () => {
            const html = renderCharacterDossier({
                ...buildDossier(),
                canonNotes: [{ id: 'canon_1', text: 'Accommodates others; never demands' }],
            });
            expect(html).toContain('Canon notes');
            expect(html).toContain('data-action="dossier-add-canon-note"');
            expect(html).toContain('data-action="dossier-remove-canon-note"');
            expect(html).toContain('Accommodates others; never demands');
        });

        it('shows the empty placeholder when there are no canon notes', () => {
            const html = renderCharacterDossier({ ...buildDossier(), canonNotes: [] });
            expect(html).toContain('No corrections set');
        });

        it('HTML-escapes canon note text', () => {
            const html = renderCharacterDossier({
                ...buildDossier(),
                canonNotes: [{ id: 'canon_1', text: '<script>x</script>' }],
            });
            expect(html).not.toContain('<script>x</script>');
        });
    });
});

describe('settings panel template', () => {
    it('contains backup profile dropdown', () => {
        expect(settingsPanelHtml).toContain('id="openvault_backup_profile"');
        expect(settingsPanelHtml).toContain('None (no failover)');
    });
});
