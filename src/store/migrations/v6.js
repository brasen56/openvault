import { INJECTION_OVERRIDES_KEY } from '../../constants.js';

/**
 * Initialize the per-character `injection_overrides` store used by the
 * identity-layer injection mode (see VISION.md — two-layer model). Older vaults
 * predate this field, so we add an empty map (Record<characterName,
 * 'always' | 'never'>) so reads never have to special-case "undefined" and the
 * get/set helpers can mutate it in place.
 *
 * @param {Object} data - OpenVault data (mutated)
 * @returns {boolean} True if injection_overrides was initialized
 */
function initInjectionOverrides(data) {
    const existing = data?.[INJECTION_OVERRIDES_KEY];
    // Expected shape: Record<characterName, 'always' | 'never'>. If it is missing
    // or not a plain object, (re)initialize to an empty map.
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return false; // already a record — nothing to do
    }
    data[INJECTION_OVERRIDES_KEY] = {};
    return true;
}

/**
 * Run full v6 migration.
 * @param {Object} data - OpenVault data (mutated)
 * @param {Array} _chat - Chat messages (unused; signature kept for migration runner)
 * @returns {boolean} True if any changes made
 */
export function migrateToV6(data, _chat) {
    return initInjectionOverrides(data);
}
