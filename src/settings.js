/**
 * OpenVault Settings Initialization
 *
 * Initializes extension settings with defaults using lodash.merge.
 * Preserves existing user settings while adding any missing defaults.
 */

import { defaultSettings, extensionName } from './constants.js';
import { getDeps } from './deps.js';

/**
 * Whether a value is a plain (non-array) object eligible for deep merge.
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge fallback used when lodash isn't available on the ST context.
 * Mirrors lodash.merge semantics for our settings: existing user values win,
 * defaults fill in any missing keys. Recurses into plain objects; arrays and
 * primitives are taken wholesale from the source. `undefined` source values
 * are skipped so they never clobber a real default.
 * @param {Object} target - The default settings clone (mutated in place).
 * @param {Object} source - Existing persisted user settings.
 * @returns {Object} target
 */
function deepMergeDefaults(target, source) {
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        if (srcVal === undefined) continue;
        if (isPlainObject(srcVal) && isPlainObject(target[key])) {
            deepMergeDefaults(target[key], srcVal);
        } else {
            target[key] = srcVal;
        }
    }
    return target;
}

/**
 * Initialize extension settings with defaults, adding any missing keys while
 * preserving existing user customizations.
 *
 * Uses lodash.merge when the ST context exposes it, otherwise falls back to a
 * manual deep merge. The fallback is the common case: SillyTavern does NOT put
 * lodash on getContext(), so without it this function would be a silent no-op
 * and newly added default settings would never reach existing users.
 *
 * Called automatically on module import when running in SillyTavern.
 */
export function loadSettings() {
    const deps = getDeps();
    const context = deps.getContext();
    const extensionSettings = deps.getExtensionSettings();

    const lodash = context?.lodash;
    const existing = extensionSettings[extensionName] || {};

    extensionSettings[extensionName] = lodash?.merge
        ? lodash.merge(structuredClone(defaultSettings), existing)
        : deepMergeDefaults(structuredClone(defaultSettings), existing);

    // One-time migration: switch CN defaults to EN for Shaderx fork
    const s = extensionSettings[extensionName];
    if (s._langMigrated !== 1) {
        if (s.preambleLanguage === 'cn') s.preambleLanguage = 'en';
        if (s.extractionPrefill === 'cn_compliance') s.extractionPrefill = 'en_compliance';
        if (s.outputLanguage === 'auto') s.outputLanguage = 'en';
        s._langMigrated = 1;
    }
}

/**
 * Get settings object or nested value using lodash.get
 * @param {string} [path] - Optional lodash path (dot notation)
 * @param {*} [defaultValue] - Default value if path not found
 * @returns {Settings|*} Settings object or value at path
 */
export function getSettings(path, defaultValue) {
    const deps = getDeps();
    const lodash = deps.getContext()?.lodash;
    const settings = deps.getExtensionSettings()[extensionName];

    if (path === undefined) {
        return settings;
    }

    if (lodash?.get) {
        return lodash.get(settings, path, defaultValue) ?? defaultValue;
    }

    // Fallback: manual path resolution when lodash isn't on the ST context.
    // Mirrors the setSetting() fallback. Without this, every keyed read silently
    // returns defaultValue and ignores stored values — e.g. boolean toggles can
    // never be turned off because getSettings('key', true) always yields true.
    const keys = String(path)
        .split(/[.[\]]+/)
        .filter(Boolean);
    let current = settings;
    for (const key of keys) {
        if (current == null || typeof current !== 'object') return defaultValue;
        const numKey = /^\d+$/.test(key) ? parseInt(key, 10) : key;
        current = current[numKey];
    }
    return current ?? defaultValue;
}

/**
 * Set settings value using lodash.set
 * @param {string} path - Lodash path (dot notation)
 * @param {*} value - Value to set
 */
export function setSetting(path, value) {
    const deps = getDeps();
    const lodash = deps.getContext()?.lodash;
    const settings = deps.getExtensionSettings()[extensionName];

    if (lodash?.set) {
        lodash.set(settings, path, value);
    } else {
        // Fallback: simple setByPath implementation
        const keys = String(path)
            .split(/[.[\]]+/)
            .filter(Boolean);
        let current = settings;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            const numKey = /^\d+$/.test(key) ? parseInt(key, 10) : key;
            if (!(numKey in current)) {
                current[numKey] = /^\d+$/.test(keys[i + 1]) ? [] : {};
            }
            current = current[numKey];
        }
        const lastKey = keys[keys.length - 1];
        const numLastKey = /^\d+$/.test(lastKey) ? parseInt(lastKey, 10) : lastKey;
        current[numLastKey] = value;
    }
    deps.saveSettingsDebounced();
}

/**
 * Check if path exists in settings
 * @param {string} path - Lodash path (dot notation)
 * @returns {boolean}
 */
export function hasSettings(path) {
    const deps = getDeps();
    const lodash = deps.getContext()?.lodash;
    const settings = deps.getExtensionSettings()[extensionName];

    return lodash?.has(settings, path) ?? false;
}

// Auto-initialize on import
loadSettings();
