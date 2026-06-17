/**
 * Regression tests for src/settings.js when lodash is NOT on the ST context.
 *
 * This is the real-world case: SillyTavern's getContext() does not expose
 * `lodash`. A previous bug relied on `lodash.get` in getSettings() (and
 * `lodash.merge` in loadSettings()) with no fallback, so:
 *   - every keyed getSettings('key', default) silently returned `default`,
 *     ignoring stored values (boolean toggles could never be turned off), and
 *   - loadSettings() was a no-op, so new default settings never reached users.
 *
 * IMPORTANT: these tests use the REAL settings.js (no vi.mock of it). The older
 * reflection toggle tests mocked getSettings, which is why they never caught
 * this. Do not mock getSettings/setSetting/loadSettings here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionName } from '../../src/constants.js';
import { setDeps } from '../../src/deps.js';
import { getSettings, loadSettings, setSetting } from '../../src/settings.js';

describe('settings.js with no lodash on the ST context', () => {
    /** @type {Record<string, any>} */
    let store;

    beforeEach(() => {
        store = { [extensionName]: {} };
        setDeps({
            console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
            // Mirrors real SillyTavern: getContext() has NO `lodash` property.
            getContext: () => ({}),
            getExtensionSettings: () => store,
            saveSettingsDebounced: vi.fn(),
        });
    });

    describe('getSettings', () => {
        it('returns a stored `false` instead of the default `true` (the read bug)', () => {
            store[extensionName].reflectionInjectionEnabled = false;
            expect(getSettings('reflectionInjectionEnabled', true)).toBe(false);
        });

        it('returns a stored `0` instead of a non-zero default', () => {
            store[extensionName].someCount = 0;
            expect(getSettings('someCount', 5)).toBe(0);
        });

        it('falls back to the default when the key is absent', () => {
            expect(getSettings('reflectionInjectionEnabled', true)).toBe(true);
        });

        it('resolves nested dot-paths', () => {
            store[extensionName].a = { b: { c: 42 } };
            expect(getSettings('a.b.c', 0)).toBe(42);
        });

        it('returns the default for a partially-missing nested path', () => {
            store[extensionName].a = {};
            expect(getSettings('a.b.c', 'fallback')).toBe('fallback');
        });

        it('returns the whole settings object when called with no path', () => {
            store[extensionName].enabled = true;
            expect(getSettings()).toBe(store[extensionName]);
        });
    });

    describe('setSetting <-> getSettings round-trip', () => {
        it('a value written by setSetting is read back by getSettings', () => {
            setSetting('contradictionFilterEnabled', false);
            expect(getSettings('contradictionFilterEnabled', true)).toBe(false);
        });

        it('round-trips a nested path', () => {
            setSetting('nested.flag', true);
            expect(getSettings('nested.flag', false)).toBe(true);
        });
    });

    describe('loadSettings', () => {
        it('merges in missing defaults while preserving existing user values', () => {
            // Existing user who customized one toggle but predates newer defaults.
            store[extensionName] = { reflectionInjectionEnabled: false };

            loadSettings();

            // User's custom value is preserved...
            expect(store[extensionName].reflectionInjectionEnabled).toBe(false);
            // ...and a default that wasn't present is now populated.
            expect(store[extensionName].reflectionGenerationEnabled).toBe(true);
        });

        it('is not a no-op: an empty settings object gets fully populated', () => {
            store[extensionName] = {};
            loadSettings();
            expect(Object.keys(store[extensionName]).length).toBeGreaterThan(0);
        });
    });
});
