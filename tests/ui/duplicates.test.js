import { describe, expect, it } from 'vitest';
import { findCharacterDuplicates } from '../../src/ui/duplicates.js';

const person = (name, mentions = 0) => ({ name, type: 'PERSON', mentions });

describe('findCharacterDuplicates', () => {
    it('flags a bare name as a duplicate of its fuller form', () => {
        const nodes = {
            greg: person('Greg'),
            'greg williams': person('Greg Williams'),
        };
        const pairs = findCharacterDuplicates(nodes);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].sourceName).toBe('Greg');
        expect(pairs[0].targetName).toBe('Greg Williams');
        expect(pairs[0].sourceKey).toBe('greg');
        expect(pairs[0].targetKey).toBe('greg williams');
    });

    it('always suggests the fuller name as the survivor regardless of node order', () => {
        const nodes = {
            'alex hiro': person('Alex Hiro'),
            alex: person('Alex'),
        };
        const [pair] = findCharacterDuplicates(nodes);
        expect(pair.sourceName).toBe('Alex');
        expect(pair.targetName).toBe('Alex Hiro');
    });

    it('ignores non-PERSON nodes', () => {
        const nodes = {
            castle: { name: 'Castle', type: 'PLACE' },
            'castle keep': { name: 'Castle Keep', type: 'PLACE' },
        };
        expect(findCharacterDuplicates(nodes)).toEqual([]);
    });

    it('does not flag unrelated names', () => {
        const nodes = {
            greg: person('Greg'),
            alex: person('Alex'),
        };
        expect(findCharacterDuplicates(nodes)).toEqual([]);
    });

    it('does not confuse similar but distinct names (Greg vs Gregory)', () => {
        const nodes = {
            greg: person('Greg'),
            gregory: person('Gregory'),
        };
        expect(findCharacterDuplicates(nodes)).toEqual([]);
    });

    it('suggests both fuller forms when a bare name matches two full names', () => {
        const nodes = {
            alex: person('Alex'),
            'alex hiro': person('Alex Hiro'),
            'alex wong': person('Alex Wong'),
        };
        const pairs = findCharacterDuplicates(nodes);
        const targets = pairs.map((p) => p.targetName).sort();
        expect(pairs).toHaveLength(2);
        expect(targets).toEqual(['Alex Hiro', 'Alex Wong']);
        expect(pairs.every((p) => p.sourceName === 'Alex')).toBe(true);
    });

    it('picks the higher-mention node as survivor for same-token reorderings', () => {
        const nodes = {
            'greg williams': person('Greg Williams', 2),
            'williams greg': person('Williams Greg', 9),
        };
        const [pair] = findCharacterDuplicates(nodes);
        expect(pair.targetName).toBe('Williams Greg');
        expect(pair.sourceName).toBe('Greg Williams');
    });

    it('handles an empty or missing node map', () => {
        expect(findCharacterDuplicates({})).toEqual([]);
        expect(findCharacterDuplicates(null)).toEqual([]);
    });
});
