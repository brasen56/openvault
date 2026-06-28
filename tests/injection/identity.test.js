import { describe, expect, it } from 'vitest';
import { buildIdentityInjectionText, getInjectableCharacters } from '../../src/injection/identity.js';

describe('identity injection', () => {
    describe('getInjectableCharacters', () => {
        const settings = { identityMinReflections: 1 };

        it('returns no characters when there are no reflections', () => {
            const data = { memories: [{ id: 'e1', type: 'event', character: 'Alice' }] };
            expect(getInjectableCharacters(data, settings)).toEqual([]);
        });

        it('auto-injects a character with at least one reflection', () => {
            const data = {
                memories: [{ id: 'r1', type: 'reflection', character: 'Alice', importance: 5, level: 3 }],
            };
            expect(getInjectableCharacters(data, settings)).toEqual(['Alice']);
        });

        it('ignores archived reflections', () => {
            const data = {
                memories: [{ id: 'r1', type: 'reflection', character: 'Alice', archived: true }],
            };
            expect(getInjectableCharacters(data, settings)).toEqual([]);
        });

        it('respects a higher identityMinReflections gate', () => {
            const data = {
                memories: [
                    { id: 'r1', type: 'reflection', character: 'Alice' },
                    { id: 'r2', type: 'reflection', character: 'Bob' },
                    { id: 'r3', type: 'reflection', character: 'Bob' },
                ],
            };
            expect(getInjectableCharacters(data, { identityMinReflections: 2 })).toEqual(['Bob']);
        });

        it('respects a per-character "never" override', () => {
            const data = {
                memories: [{ id: 'r1', type: 'reflection', character: 'Alice' }],
                injection_overrides: { Alice: 'never' },
            };
            expect(getInjectableCharacters(data, settings)).toEqual([]);
        });

        it('forces an "always" character in even below the gate', () => {
            const data = {
                memories: [
                    { id: 'r1', type: 'reflection', character: 'Alice' },
                    { id: 'r2', type: 'reflection', character: 'Bob' },
                ],
                injection_overrides: { Bob: 'always' },
            };
            // gate 2 -> Alice excluded; Bob forced in
            expect(getInjectableCharacters(data, { identityMinReflections: 2 })).toEqual(['Bob']);
        });

        it('returns a sorted list', () => {
            const data = {
                memories: [
                    { id: 'r1', type: 'reflection', character: 'Zelda' },
                    { id: 'r2', type: 'reflection', character: 'Alice' },
                ],
            };
            expect(getInjectableCharacters(data, settings)).toEqual(['Alice', 'Zelda']);
        });
    });

    describe('buildIdentityInjectionText', () => {
        it('returns empty string when no characters qualify', () => {
            expect(buildIdentityInjectionText({ memories: [] }, {})).toBe('');
        });

        it('renders a dossier sheet without the export footer', () => {
            const data = {
                memories: [
                    {
                        id: 'r1',
                        type: 'reflection',
                        character: 'Alice',
                        importance: 5,
                        level: 3,
                        summary: 'Alice is guarded but adaptive',
                    },
                ],
                character_states: {},
                reflection_state: { Alice: { importance_sum: 0 } },
                graph: { nodes: {}, edges: {} },
            };
            const text = buildIdentityInjectionText(data, { reflectionThreshold: 40 });
            expect(text).toContain('Alice');
            expect(text).not.toContain('Exported from OpenVault');
        });
    });
});
