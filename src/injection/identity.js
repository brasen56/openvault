/**
 * OpenVault Identity Injection
 *
 * The character-identity injection path. Instead of retrieving per-turn events
 * (the episodic-memory job, now owned by a RAG extension such as VectFox),
 * OpenVault injects a stable, per-character "who this character is right now"
 * sheet synthesized from reflections. The sheet is mostly constant between
 * turns — it only changes when a reflection lands or a canon note changes.
 *
 * See VISION.md (two-layer model) and ROADMAP_Dossier.md.
 *
 * This module is intentionally thin: the heavy lifting (reflections -> dossier)
 * lives in buildCharacterDossier / formatDossierAsText (ui/helpers.js). Here we
 * decide *which* characters to inject and *where* to put the sheet.
 */

import { buildCharacterDossier, formatDossierForInjection } from '../ui/helpers.js';
import { cachedContent } from './macros.js';
import { getSettings } from '../settings.js';
import { getOpenVaultData } from '../store/chat-data.js';
import { logDebug } from '../utils/logging.js';
import { clearAllInjectionSlots, isExtensionEnabled, safeSetExtensionPrompt } from '../utils/st-helpers.js';

/** Case-insensitive name key (mirrors helpers.js normalizeName). */
function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
}

/**
 * Resolve a character's identity-injection override, looking up by display name
 * then by normalized key.
 */
function resolveOverride(overrides, display, norm) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, display)) {
        const v = overrides[display];
        if (v === 'always' || v === 'never') return v;
    }
    if (norm !== display && overrides && Object.prototype.hasOwnProperty.call(overrides, norm)) {
        const v = overrides[norm];
        if (v === 'always' || v === 'never') return v;
    }
    return 'auto';
}

/**
 * Decide which characters' dossiers to inject, applying per-character overrides
 * on top of the reflection-count auto-gate. Pure — no DOM, no mutation.
 *
 * A character is a candidate once they have any synthesized reflection. They are
 * auto-injected when their reflection count >= settings.identityMinReflections,
 * unless an override ('always' / 'never') forces or suppresses them.
 *
 * @param {Object} data - OpenVault data ({ memories, injection_overrides })
 * @param {Object} settings - Extension settings ({ identityMinReflections })
 * @returns {string[]} Character display names to inject (sorted for stable order)
 */
export function getInjectableCharacters(data, settings) {
    const memories = data?.memories || [];
    const overrides = data?.injection_overrides || {};
    const minReflections = Math.max(1, Number(settings?.identityMinReflections) || 1);

    const counts = new Map(); // normalized -> reflection count
    const displayOf = new Map(); // normalized -> display name (first seen)
    for (const m of memories) {
        if (m.type !== 'reflection' || m.archived) continue;
        const raw = m.character;
        if (!raw) continue;
        const norm = normalizeName(raw);
        if (!displayOf.has(norm)) displayOf.set(norm, raw);
        counts.set(norm, (counts.get(norm) || 0) + 1);
    }

    const result = [];
    for (const [norm, count] of counts) {
        const display = displayOf.get(norm) || norm;
        const ov = resolveOverride(overrides, display, norm);
        if (ov === 'never') continue;
        if (ov === 'always' || count >= minReflections) {
            result.push(display);
        }
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
}

/**
 * Build the combined identity-injection text for all injectable characters:
 * each character's dossier sheet (no export footer), concatenated. Pure.
 *
 * @param {Object} data - OpenVault data
 * @param {Object} settings - Extension settings ({ reflectionThreshold })
 * @returns {string} Combined sheet text, or '' if no characters qualify
 */
export function buildIdentityInjectionText(data, settings) {
    const characters = getInjectableCharacters(data, settings);
    if (characters.length === 0) return '';
    const threshold = Number(settings?.reflectionThreshold) || 40;
    const budget = Math.max(1, Number(settings?.identityInjectionBudget) || 2000);
    const parts = [];
    for (const name of characters) {
        const dossier = buildCharacterDossier(name, data, threshold);
        // Bounded injection formatter — caps each section and trims to the
        // per-character token budget so a well-connected character can't
        // flood the context (see formatDossierForInjection).
        parts.push(formatDossierForInjection(dossier, { maxTokens: budget }));
    }
    return parts.join('\n\n');
}

/**
 * Push the identity sheet into the prompt and clear the legacy event/world
 * slots. In 'identity' mode OpenVault owns exactly one injection (the dossier),
 * so it never competes with a coinstalled episodic-memory extension.
 *
 * @param {string} text - Combined dossier text ('' to inject nothing)
 * @param {Object} settings - Extension settings ({ injection.identity })
 * @returns {boolean} True if a non-empty sheet was injected
 */
export function injectIdentitySheet(text, settings) {
    const pos = settings?.injection?.identity?.position ?? 5;
    const depth = settings?.injection?.identity?.depth ?? 4;

    // Clear every slot (incl. the episodic-layer memory/world/entities/posthistory
    // slots and the identity slot itself) so nothing from events mode — or a prior
    // identity build — lingers. In identity mode OpenVault owns exactly one
    // injection, so it never competes with a coinstalled episodic-memory extension.
    cachedContent.memory = '';
    cachedContent.world = '';
    clearAllInjectionSlots();

    if (!text) {
        return false;
    }
    safeSetExtensionPrompt(text, 'openvault_identity', pos, depth);
    return true;
}

/**
 * Pre-generation entry point for identity mode: build and inject the combined
 * identity sheet for all qualifying characters. Mirrors the shape of
 * retrieve.js#updateInjection so events.js can branch on injectionMode.
 *
 * @returns {Promise<{characters: string[], text: string}|null>}
 */
export async function updateIdentityInjection() {
    if (!isExtensionEnabled()) {
        injectIdentitySheet('', getSettings());
        return null;
    }
    const data = getOpenVaultData();
    const settings = getSettings();
    if (!data) {
        injectIdentitySheet('', settings);
        return null;
    }
    const text = buildIdentityInjectionText(data, settings);
    injectIdentitySheet(text, settings);
    const characters = getInjectableCharacters(data, settings);
    logDebug(`Identity injection: ${characters.length} character(s) [${characters.join(', ')}]`);
    return { characters, text };
}

