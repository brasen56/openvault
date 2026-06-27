import { describe, expect, it } from 'vitest';
import { buildUnifiedReflectionPrompt } from '../../src/prompts/index.js';

describe('buildUnifiedReflectionPrompt — canon notes (Phase 3 correction loop)', () => {
    const buildPrompt = (canonNotes) =>
        buildUnifiedReflectionPrompt(
            'Alice',
            [{ id: 'ev_1', importance: 4, type: 'event', summary: 'Alice greeted Bob' }],
            [],
            'Alice is kind.',
            'auto',
            'auto',
            '',
            canonNotes
        );

    it('injects canon notes as an OVERRIDE constraint section', () => {
        const result = buildPrompt([{ id: 'canon_1', text: 'Accommodates others; never demands' }]);
        const user = result[1].content;
        expect(user).toContain('<canon_notes>');
        expect(user).toContain('</canon_notes>');
        expect(user).toContain('Accommodates others; never demands');
        expect(user).toContain('OVERRIDE');
    });

    it('places canon notes before the recent memories', () => {
        const result = buildPrompt([{ id: 'canon_1', text: 'Never demands ASL' }]);
        const user = result[1].content;
        expect(user.indexOf('<canon_notes>')).toBeLessThan(user.indexOf('<recent_memories>'));
    });

    it('renders multiple canon notes as a list', () => {
        const result = buildPrompt([
            { id: 'canon_1', text: 'Accommodates others' },
            { id: 'canon_2', text: 'Loves cats' },
        ]);
        const user = result[1].content;
        expect(user).toContain('- Accommodates others');
        expect(user).toContain('- Loves cats');
    });

    it('omits the canon_notes section when none are provided', () => {
        const result = buildPrompt([]);
        const user = result[1].content;
        expect(user).not.toContain('<canon_notes>');
    });

    it('omits the canon_notes section for blank-only notes', () => {
        const result = buildPrompt([{ id: 'canon_1', text: '   ' }]);
        const user = result[1].content;
        expect(user).not.toContain('<canon_notes>');
    });
});
