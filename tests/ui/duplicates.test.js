import { describe, expect, it } from 'vitest';
import { findCharacterDuplicates } from '../../src/ui/duplicates.js';
import { characterMergePairKey } from '../../src/store/chat-data.js';

const person = (name, mentions = 0, description = '') => ({ name, type: 'PERSON', mentions, description });
const withGraph = (nodes, extra = {}) => ({ graph: { nodes }, ...extra });

describe('characterMergePairKey', () => {
    it('produces a stable, order-independent key', () => {
        expect(characterMergePairKey('Alice', 'Bob')).toBe(characterMergePairKey('Bob', 'Alice'));
    });

    it('lowercases and sorts the names', () => {
        expect(characterMergePairKey('Marcus', 'Alex')).toBe('alex||marcus');
    });

    it('handles empty / falsy names defensively', () => {
        expect(characterMergePairKey('', '')).toBe('||');
        expect(characterMergePairKey('Alice', null)).toBe('||alice');
    });
});

describe('findCharacterDuplicates', () => {
    it('flags a bare name as a duplicate of its fuller form', () => {
        const data = withGraph({ greg: person('Greg'), 'greg williams': person('Greg Williams') });
        const pairs = findCharacterDuplicates(data);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].sourceName).toBe('Greg');
        expect(pairs[0].targetName).toBe('Greg Williams');
    });

    it('always suggests the fuller name as the survivor regardless of node order', () => {
        const data = withGraph({ 'alex hiro': person('Alex Hiro'), alex: person('Alex') });
        const [pair] = findCharacterDuplicates(data);
        expect(pair.sourceName).toBe('Alex');
        expect(pair.targetName).toBe('Alex Hiro');
    });

    it('ignores non-PERSON nodes', () => {
        const data = withGraph({
            castle: { name: 'Castle', type: 'PLACE' },
            'castle keep': { name: 'Castle Keep', type: 'PLACE' },
        });
        expect(findCharacterDuplicates(data)).toEqual([]);
    });

    it('does not flag unrelated names', () => {
        const data = withGraph({ greg: person('Greg'), alex: person('Alex') });
        expect(findCharacterDuplicates(data)).toEqual([]);
    });

    it('does not confuse similar but distinct names (Greg vs Gregory)', () => {
        const data = withGraph({ greg: person('Greg'), gregory: person('Gregory') });
        expect(findCharacterDuplicates(data)).toEqual([]);
    });

    it('suggests both fuller forms when a bare name matches two full names', () => {
        const data = withGraph({
            alex: person('Alex'),
            'alex hiro': person('Alex Hiro'),
            'alex wong': person('Alex Wong'),
        });
        const pairs = findCharacterDuplicates(data);
        const targets = pairs.map((p) => p.targetName).sort();
        expect(pairs).toHaveLength(2);
        expect(targets).toEqual(['Alex Hiro', 'Alex Wong']);
        expect(pairs.every((p) => p.sourceName === 'Alex')).toBe(true);
    });

    it('detects an orphaned character_states name with no graph node', () => {
        // "Alex" exists only in character_states; "Alex Hiro" is the graph node.
        const data = withGraph(
            { 'alex hiro': person('Alex Hiro', 50) },
            {
                character_states: {
                    Alex: { name: 'Alex', known_events: new Array(277).fill('e') },
                    'Alex Hiro': { name: 'Alex Hiro', known_events: new Array(1246).fill('e') },
                },
            }
        );
        const pairs = findCharacterDuplicates(data);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].sourceName).toBe('Alex');
        expect(pairs[0].targetName).toBe('Alex Hiro');
        // Orphan side carries its event count for context; survivor carries its description
        expect(pairs[0].sourceMeta).toBe('277 known events');
        expect(pairs[0].targetDesc).toBe('');
    });

    it('also scans reflection_state keys', () => {
        const data = withGraph(
            {},
            {
                reflection_state: { Greg: { importance_sum: 10 }, 'Greg Williams': { importance_sum: 4 } },
            }
        );
        const pairs = findCharacterDuplicates(data);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].targetName).toBe('Greg Williams');
    });

    it('carries description context so two similar names can be told apart', () => {
        const data = withGraph({
            marcus: person('Marcus', 8, 'the stable boy'),
            'marcus feltner': person('Marcus Feltner', 20, 'the merchant lord'),
        });
        const [pair] = findCharacterDuplicates(data);
        expect(pair.sourceDesc).toBe('the stable boy');
        expect(pair.targetDesc).toBe('the merchant lord');
    });

    it('picks the more active node as survivor for same-token reorderings', () => {
        const data = withGraph({
            'greg williams': person('Greg Williams', 2),
            'williams greg': person('Williams Greg', 9),
        });
        const [pair] = findCharacterDuplicates(data);
        expect(pair.targetName).toBe('Williams Greg');
        expect(pair.sourceName).toBe('Greg Williams');
    });

    it('handles empty or missing data', () => {
        expect(findCharacterDuplicates({})).toEqual([]);
        expect(findCharacterDuplicates(null)).toEqual([]);
        expect(findCharacterDuplicates(withGraph({}))).toEqual([]);
    });
});
