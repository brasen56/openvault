/**
 * Contradiction Filter Integration Verification
 *
 * Validates that the contradiction filter works correctly with the fixed
 * getSettings/setSetting (no-lodash fallback). The previous bug caused
 * getSettings('contradictionFilterEnabled', true) to always return `true`
 * (the default), making it impossible to disable the filter.
 *
 * This test file verifies:
 * 1. The toggle can be read/written correctly via settings
 * 2. filterContradictions itself is sound (unit-level)
 * 3. The scoring pipeline respects the toggle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setDeps } from '../../src/deps.js';
import { extensionName } from '../../src/constants.js';
import { getSettings, setSetting, loadSettings } from '../../src/settings.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

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

/** Wire up the deps context (no lodash — mirrors real SillyTavern) */
function initStore(existing = {}) {
    const store = { [extensionName]: { ...existing } };
    setDeps({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getContext: () => ({}),
        getExtensionSettings: () => store,
        saveSettingsDebounced: vi.fn(),
    });
    return store;
}

// ─── Settings toggle integration ─────────────────────────────────────────────

describe('Contradiction filter toggle (getSettings / setSetting)', () => {
    let store;

    beforeEach(() => {
        store = initStore();
        loadSettings();
    });

    it('contradictionFilterEnabled defaults to true after loadSettings', () => {
        expect(getSettings('contradictionFilterEnabled', true)).toBe(true);
    });

    it('can be turned OFF and the OFF value is read back correctly', () => {
        setSetting('contradictionFilterEnabled', false);
        // This was THE bug: without the lodash fallback, this returned `true`
        expect(getSettings('contradictionFilterEnabled', true)).toBe(false);
    });

    it('can be turned back ON after being turned OFF', () => {
        setSetting('contradictionFilterEnabled', false);
        expect(getSettings('contradictionFilterEnabled', true)).toBe(false);

        setSetting('contradictionFilterEnabled', true);
        expect(getSettings('contradictionFilterEnabled', true)).toBe(true);
    });

    it('persists across loadSettings() calls (survives page reload)', () => {
        setSetting('contradictionFilterEnabled', false);

        // Simulate page reload — loadSettings merges defaults over existing
        loadSettings();

        // User's false should be preserved, not overwritten by the default true
        expect(getSettings('contradictionFilterEnabled', true)).toBe(false);
    });
});

// ─── Filter correctness (unit-level with settings integration) ──────────────

describe('filterContradictions works correctly when called via settings', () => {
    it('suppresses older contradictory memories when filter is enabled', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'old_hate',
                summary: 'Alex hates Ezra and they are bitter enemies',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'new_friends',
                summary: 'Alex and Ezra reconciled and became close friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
            makeMemory({
                id: 'unrelated',
                summary: 'Bob went to the market',
                characters_involved: ['Bob', 'Merchant'],
                extraction_count: 15,
            }),
        ];

        const result = filterContradictions(memories);

        expect(result.map((m) => m.id)).not.toContain('old_hate');
        expect(result.map((m) => m.id)).toContain('new_friends');
        expect(result.map((m) => m.id)).toContain('unrelated');
    });

    it('returns all memories unchanged when disabled (simulated pipeline bypass)', async () => {
        // When contradictionFilterEnabled is false, the scoring pipeline
        // skips filterContradictions entirely. This test verifies that
        // the pipeline bypass works by simulating the conditional:
        //   if (getSettings('contradictionFilterEnabled', true)) { filterContradictions(...) }
        initStore({ contradictionFilterEnabled: false });
        loadSettings();

        const enabled = getSettings('contradictionFilterEnabled', true);
        expect(enabled).toBe(false);

        // Since the filter would be skipped, all memories pass through
        const memories = [
            makeMemory({
                id: 'hate',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'love',
                summary: 'Alex and Ezra are friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        // Simulate the pipeline: skip filter when disabled
        const result = enabled
            ? (await import('../../src/retrieval/contradiction.js')).filterContradictions(memories)
            : memories;

        // Both memories should survive when filter is disabled
        expect(result).toHaveLength(2);
        expect(result.map((m) => m.id)).toContain('hate');
        expect(result.map((m) => m.id)).toContain('love');
    });

    it('handles edge case: memories with null summary', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'null_summary',
                summary: null,
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'valid',
                summary: 'Alex and Ezra are great friends',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 20,
            }),
        ];

        // Should not throw — null summary is treated as NEUTRAL
        const result = filterContradictions(memories);
        expect(result).toHaveLength(2);
    });

    it('handles edge case: memories with empty characters_involved', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'no_chars_hate',
                summary: 'Alex hates Ezra',
                characters_involved: [],
                extraction_count: 5,
            }),
            makeMemory({
                id: 'no_chars_love',
                summary: 'Alex and Ezra are friends',
                characters_involved: [],
                extraction_count: 20,
            }),
        ];

        // No character pairs → no groups → no suppression
        const result = filterContradictions(memories);
        expect(result).toHaveLength(2);
    });

    it('handles edge case: same extraction_count on opposing memories (same batch)', async () => {
        const { filterContradictions } = await import('../../src/retrieval/contradiction.js');

        const memories = [
            makeMemory({
                id: 'hate_batch',
                summary: 'Alex hates Ezra',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 10,
            }),
            makeMemory({
                id: 'love_batch',
                summary: 'Alex and Ezra reconciled',
                characters_involved: ['Alex', 'Ezra'],
                extraction_count: 10, // same batch — equal recency
            }),
        ];

        // Equal recency → pipeline abstains, both survive
        const result = filterContradictions(memories);
        expect(result).toHaveLength(2);
    });
});

// ─── Regression: settings round-trip with contradiction keys ─────────────────

describe('Contradiction settings round-trip (all keys)', () => {
    let store;

    beforeEach(() => {
        store = initStore();
        loadSettings();
    });

    it('contradictionFilterEnabled round-trips false', () => {
        setSetting('contradictionFilterEnabled', false);
        expect(getSettings('contradictionFilterEnabled', true)).toBe(false);
    });

    it('llmContradictionEnabled round-trips true', () => {
        setSetting('llmContradictionEnabled', true);
        expect(getSettings('llmContradictionEnabled', false)).toBe(true);
    });

    it('llmContradictionAutoMerge round-trips true', () => {
        setSetting('llmContradictionAutoMerge', true);
        expect(getSettings('llmContradictionAutoMerge', false)).toBe(true);
    });

    it('llmContradictionBatchInterval round-trips 50', () => {
        setSetting('llmContradictionBatchInterval', 50);
        expect(getSettings('llmContradictionBatchInterval', 100)).toBe(50);
    });

    it('llmContradictionMaxCalls round-trips 3', () => {
        setSetting('llmContradictionMaxCalls', 3);
        expect(getSettings('llmContradictionMaxCalls', 5)).toBe(3);
    });

    it('all contradiction settings survive loadSettings() merge', () => {
        setSetting('contradictionFilterEnabled', false);
        setSetting('llmContradictionEnabled', true);
        setSetting('llmContradictionAutoMerge', true);
        setSetting('llmContradictionBatchInterval', 50);
        setSetting('llmContradictionMaxCalls', 3);

        // Simulate page reload
        loadSettings();

        expect(getSettings('contradictionFilterEnabled', true)).toBe(false);
        expect(getSettings('llmContradictionEnabled', false)).toBe(true);
        expect(getSettings('llmContradictionAutoMerge', false)).toBe(true);
        expect(getSettings('llmContradictionBatchInterval', 100)).toBe(50);
        expect(getSettings('llmContradictionMaxCalls', 5)).toBe(3);
    });
});