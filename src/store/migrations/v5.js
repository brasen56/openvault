import { CANON_NOTES_KEY } from '../../constants.js';

/**
 * Initialize the per-character `canon_notes` store used by the Phase 3
 * correction loop. Older vaults predate this field, so we add an empty map
 * (Record<characterName, CanonNote[]>) so reads never have to special-case
 * "undefined" and the add/remove helpers can mutate it in place.
 *
 * @param {Object} data - OpenVault data (mutated)
 * @returns {boolean} True if canon_notes was initialized
 */
function initCanonNotes(data) {
    const existing = data?.[CANON_NOTES_KEY];
    // Expected shape: Record<characterName, CanonNote[]>. If it is missing or
    // not a plain object, (re)initialize to an empty map.
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return false; // already a record — nothing to do
    }
    data[CANON_NOTES_KEY] = {};
    return true;
}

/**
 * Run full v5 migration.
 * @param {Object} data - OpenVault data (mutated)
 * @param {Array} _chat - Chat messages (unused; signature kept for migration runner)
 * @returns {boolean} True if any changes made
 */
export function migrateToV5(data, _chat) {
    return initCanonNotes(data);
}
