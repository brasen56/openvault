/**
 * OpenVault Conflict/Duplicate Resolution UI
 *
 * Panel for reviewing near-duplicate memories that were flagged during dedup.
 * Shows the original and duplicate side-by-side with accept/reject actions.
 */

import { ENTITY_TYPES, MEMORIES_KEY } from '../constants.js';
import { normalizeKey } from '../graph/graph.js';
import {
    deleteMemory as deleteMemoryAction,
    dismissCharacterMerge,
    getOpenVaultData,
    isCharacterMergeDismissed,
    mergeEntities,
    reconcileCharacterIdentity,
    renameCharacter,
    saveOpenVaultData,
    updateEntity,
} from '../store/chat-data.js';
import { escapeHtml, showToast } from '../utils/dom.js';
import { tokenizeName } from '../utils/transliterate.js';

// =============================================================================
// Data Access
// =============================================================================

/**
 * Get all non-archived memories sorted by mentions (descending).
 * @returns {Object[]}
 */
function getAllMemories() {
    const data = getOpenVaultData();
    return (data?.[MEMORIES_KEY] || []).filter((m) => !m.archived);
}

/**
 * Find potential near-duplicates among all memories by comparing consecutive
 * memories sorted by similarity heuristics.
 *
 * Strategy: Sort memories by message_id then compare adjacent pairs by:
 * 1. Character overlap (characters_involved Jaccard >= 0.5)
 * 2. Summary token overlap (Jaccard >= 0.3 but < dedupJaccardThreshold)
 *
 * These are "near duplicates" that survived the strict dedup but may still
 * be redundant. Returns an array of candidate pairs for review.
 *
 * @returns {Array<{ a: Object, b: Object, charOverlap: number, tokenOverlap: number, reason: string }>}
 */
export function findNearDuplicates() {
    const memories = getAllMemories();
    if (memories.length < 2) return [];

    // Sort by message_id ascending for chronological grouping
    const sorted = [...memories].sort((a, b) => (a.message_id || 0) - (b.message_id || 0));

    /** @param {string[]|undefined} arr */
    const toSet = (arr) => new Set((arr || []).map((s) => s.toLowerCase()));

    /** @param {Set} a @param {Set} b */
    const jaccard = (a, b) => {
        if (a.size === 0 && b.size === 0) return 0;
        let intersection = 0;
        for (const item of a) {
            if (b.has(item)) intersection++;
        }
        return intersection / (a.size + b.size - intersection);
    };

    /** Tokenize summary into word tokens */
    const tokenize = (text) => {
        if (!text) return new Set();
        return new Set(
            text
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .split(/\s+/)
                .filter((t) => t.length > 2)
        );
    };

    const candidates = [];

    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < Math.min(i + 15, sorted.length); j++) {
            const a = sorted[i];
            const b = sorted[j];

            // Skip if this pair was already reviewed via skip/merge.
            // Both memories get _dup_reviewed = true when the user resolves
            // a pair, so checking both avoids hiding unrelated pairs that
            // happen to share one reviewed memory.
            if (a._dup_reviewed && b._dup_reviewed) continue;

            // Skip different types (event vs reflection)
            if ((a.type || 'event') !== (b.type || 'event')) continue;

            const charsA = toSet(a.characters_involved);
            const charsB = toSet(b.characters_involved);
            const charOverlap = jaccard(charsA, charsB);

            // Must share at least some characters or both have none
            if (charsA.size > 0 && charsB.size > 0 && charOverlap < 0.3) continue;

            const tokensA = tokenize(a.summary);
            const tokensB = tokenize(b.summary);
            const tokenOverlap = jaccard(tokensA, tokensB);

            // Near-duplicate threshold: Jaccard >= 0.25 and < 0.6
            // Below 0.25: too different. Above 0.6: would have been caught by dedup.
            if (tokenOverlap < 0.25 || tokenOverlap >= 0.6) continue;

            let reason = 'Similar summaries with overlapping characters';
            if (charOverlap >= 0.5) {
                reason = 'Same characters involved in similar events';
            }

            candidates.push({
                a,
                b,
                charOverlap,
                tokenOverlap,
                reason,
            });
        }
    }

    // Sort by token overlap descending (most similar first)
    candidates.sort((x, y) => y.tokenOverlap - x.tokenOverlap);

    return candidates;
}

/**
 * Format a short context line for a character from its activity counts.
 * @param {{knownEvents: number, mentions: number}} p
 * @returns {string}
 */
function characterMeta(p) {
    if (p.knownEvents > 0) return `${p.knownEvents} known event${p.knownEvents !== 1 ? 's' : ''}`;
    if (p.mentions > 0) return `${p.mentions} mention${p.mentions !== 1 ? 's' : ''}`;
    return '';
}

/**
 * Find likely duplicate characters across ALL identity stores — graph PERSON
 * nodes, character_states keys, and reflection_state keys — by comparing name
 * tokens. Scanning every store (not just graph nodes) catches names that live in
 * character_states but were never, or are no longer, a graph node — which neither
 * the entity view nor a node-only scan can surface.
 *
 * A pair is flagged when one name's tokens are a subset of the other's
 * (e.g. "Alex" vs "Alex Hiro") or both share the same token set in a different
 * order. The fuller name (more tokens, or higher activity on a tie) is suggested
 * as the survivor. Each side carries a description + count so similarly-named
 * characters (e.g. two different "Marcus" entries) can be told apart.
 *
 * @param {Object} data - OpenVault data ({ graph, character_states, reflection_state })
 * @returns {Array<{sourceName: string, targetName: string, sourceDesc: string, targetDesc: string, sourceMeta: string, targetMeta: string, reason: string}>}
 */
export function findCharacterDuplicates(data) {
    const graphNodes = data?.graph?.nodes || {};
    const states = data?.character_states || {};
    const reflectionState = data?.reflection_state || {};

    // Registry keyed by lowercased name so the same character across stores merges
    // into one entry (and historical case drift collapses together).
    /** @type {Map<string, {name: string, desc: string, mentions: number, knownEvents: number}>} */
    const registry = new Map();
    const upsert = (name, patch) => {
        if (!name || typeof name !== 'string') return;
        const key = name.toLowerCase();
        const cur = registry.get(key) || { name, desc: '', mentions: 0, knownEvents: 0 };
        registry.set(key, { ...cur, ...patch });
    };

    for (const node of Object.values(graphNodes)) {
        if (node?.type === ENTITY_TYPES.PERSON && node.name) {
            upsert(node.name, { desc: node.description || '', mentions: node.mentions || 0 });
        }
    }
    for (const [name, st] of Object.entries(states)) {
        upsert(name, { knownEvents: (st?.known_events || []).length });
    }
    for (const name of Object.keys(reflectionState)) {
        upsert(name, {});
    }

    const people = [...registry.values()]
        .map((p) => ({ ...p, tokens: tokenizeName(p.name), weight: (p.mentions || 0) + (p.knownEvents || 0) }))
        .filter((p) => p.tokens.length > 0);

    const pairs = [];
    for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) {
            const a = people[i];
            const b = people[j];
            const setA = new Set(a.tokens);
            const setB = new Set(b.tokens);
            const aInB = [...setA].every((t) => setB.has(t));
            const bInA = [...setB].every((t) => setA.has(t));

            let shorter;
            let longer;
            if (aInB && bInA) {
                // Same token set, different display name (e.g. reordered) — survivor
                // is whichever is more active, falling back to the first.
                [longer, shorter] = a.weight >= b.weight ? [a, b] : [b, a];
            } else if (aInB) {
                shorter = a;
                longer = b; // a's tokens ⊂ b's tokens → b is fuller
            } else if (bInA) {
                shorter = b;
                longer = a;
            } else {
                continue;
            }

            // Skip pairs the user has already dismissed ("not the same person").
            if (isCharacterMergeDismissed(shorter.name, longer.name)) continue;

            pairs.push({
                sourceName: shorter.name,
                targetName: longer.name,
                sourceDesc: shorter.desc,
                targetDesc: longer.desc,
                sourceMeta: characterMeta(shorter),
                targetMeta: characterMeta(longer),
                reason: `"${shorter.name}" may be the same person as "${longer.name}"`,
            });
        }
    }

    return pairs;
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Render a single duplicate candidate pair.
 * @param {Object} candidate
 * @param {number} index
 * @returns {string} HTML string
 */
function renderDuplicatePair(candidate, index) {
    const { a, b, charOverlap, tokenOverlap, reason } = candidate;

    const similarityPct = Math.round(tokenOverlap * 100);
    const charPct = Math.round(charOverlap * 100);

    return `
        <div class="openvault-dup-pair" data-index="${index}" data-a-id="${escapeHtml(a.id)}" data-b-id="${escapeHtml(b.id)}">
            <div class="openvault-dup-header">
                <span class="openvault-dup-badge">Near-Duplicate</span>
                <span class="openvault-dup-scores">
                    <span title="Token overlap">Summary: ${similarityPct}% similar</span>
                    ${charOverlap > 0 ? `<span title="Character overlap"> | Characters: ${charPct}% overlap</span>` : ''}
                </span>
                <span class="openvault-dup-reason">${escapeHtml(reason)}</span>
            </div>
            <div class="openvault-dup-cards">
                <div class="openvault-dup-card openvault-dup-card-a">
                    <div class="openvault-dup-card-label">Memory A</div>
                    <div class="openvault-dup-card-body">
                        <div class="openvault-dup-summary">${escapeHtml(a.summary || 'No summary')}</div>
                        <div class="openvault-dup-meta">
                            <span>ID: ${escapeHtml(a.id.slice(0, 12))}...</span>
                            <span>Characters: ${escapeHtml((a.characters_involved || []).join(', ') || 'None')}</span>
                            <span>Mentions: ${a.mentions || 1}</span>
                        </div>
                    </div>
                </div>
                <div class="openvault-dup-card openvault-dup-card-b">
                    <div class="openvault-dup-card-label">Memory B</div>
                    <div class="openvault-dup-card-body">
                        <div class="openvault-dup-summary">${escapeHtml(b.summary || 'No summary')}</div>
                        <div class="openvault-dup-meta">
                            <span>ID: ${escapeHtml(b.id.slice(0, 12))}...</span>
                            <span>Characters: ${escapeHtml((b.characters_involved || []).join(', ') || 'None')}</span>
                            <span>Mentions: ${b.mentions || 1}</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="openvault-dup-footer">
                <button class="openvault-dup-keep openvault-dup-action-btn" data-action="keep-a" data-index="${index}">
                    <i class="fa-solid fa-check"></i> Keep A, Delete B
                </button>
                <button class="openvault-dup-keep openvault-dup-action-btn" data-action="keep-b" data-index="${index}">
                    <i class="fa-solid fa-check"></i> Keep B, Delete A
                </button>
                <button class="openvault-dup-skip openvault-dup-action-btn secondary" data-action="skip" data-index="${index}">
                    <i class="fa-solid fa-forward"></i> Skip (keep both)
                </button>
                <button class="openvault-dup-merge-btn openvault-dup-action-btn" data-action="merge" data-index="${index}">
                    <i class="fa-solid fa-object-group"></i> Merge
                </button>
            </div>
        </div>
    `;
}

/**
 * Render one side (character) of a suggested merge with its disambiguating context.
 * @param {string} label - Column label
 * @param {string} name - Character display name
 * @param {string} meta - Short activity line (e.g. "277 known events")
 * @param {string} desc - Entity description (may be empty for state-only characters)
 * @returns {string} HTML string
 */
function renderCharacterDuplicateCard(label, name, meta, desc) {
    const metaLine = meta ? `<div class="openvault-char-dup-meta">${escapeHtml(meta)}</div>` : '';
    const descLine = desc
        ? `<div class="openvault-char-dup-desc">${escapeHtml(desc)}</div>`
        : `<div class="openvault-char-dup-desc openvault-char-dup-desc-empty">No description (state only)</div>`;
    return `
        <div class="openvault-dup-card">
            <div class="openvault-dup-card-label">${label}</div>
            <div class="openvault-dup-card-body">
                <div class="openvault-dup-summary">${escapeHtml(name)}</div>
                ${metaLine}
                ${descLine}
            </div>
        </div>
    `;
}

/**
 * Render a single suggested character-merge pair.
 * @param {{sourceName: string, targetName: string, sourceDesc: string, targetDesc: string, sourceMeta: string, targetMeta: string, reason: string}} pair
 * @returns {string} HTML string
 */
function renderCharacterDuplicatePair(pair) {
    return `
        <div class="openvault-dup-pair openvault-char-dup-pair">
            <div class="openvault-dup-header">
                <span class="openvault-dup-badge">Possible same character</span>
                <span class="openvault-dup-reason">${escapeHtml(pair.reason)}</span>
            </div>
            <div class="openvault-dup-cards">
                ${renderCharacterDuplicateCard('Absorb', pair.sourceName, pair.sourceMeta, pair.sourceDesc)}
                ${renderCharacterDuplicateCard('Into (survives)', pair.targetName, pair.targetMeta, pair.targetDesc)}
            </div>
            <div class="openvault-dup-footer">
                <button class="openvault-char-merge-confirm openvault-dup-action-btn" data-source-name="${escapeHtml(pair.sourceName)}" data-target-name="${escapeHtml(pair.targetName)}">
                    <i class="fa-solid fa-object-group"></i> Merge "${escapeHtml(pair.sourceName)}" → "${escapeHtml(pair.targetName)}"
                </button>
                <button class="openvault-char-rename-btn openvault-dup-action-btn" data-rename-name="${escapeHtml(pair.sourceName)}" title="Edit &quot;${escapeHtml(pair.sourceName)}&quot; into its full name (e.g. add a surname)">
                    <i class="fa-solid fa-pen"></i> Rename "${escapeHtml(pair.sourceName)}"
                </button>
                <button class="openvault-char-rename-btn openvault-dup-action-btn" data-rename-name="${escapeHtml(pair.targetName)}" title="Edit &quot;${escapeHtml(pair.targetName)}&quot; into its full name">
                    <i class="fa-solid fa-pen"></i> Rename "${escapeHtml(pair.targetName)}"
                </button>
                <button class="openvault-char-dismiss-btn openvault-dup-action-btn secondary" data-source-name="${escapeHtml(pair.sourceName)}" data-target-name="${escapeHtml(pair.targetName)}" title="They are not the same person — don't suggest this again">
                    <i class="fa-solid fa-user-slash"></i> Not the same
                </button>
            </div>
        </div>
    `;
}

/**
 * Build the suggested character-merges section (empty string when none).
 * @returns {string} HTML string
 */
function renderCharacterDuplicatesSection() {
    const data = getOpenVaultData();
    const pairs = findCharacterDuplicates(data);
    if (pairs.length === 0) return '';

    const rows = pairs.map(renderCharacterDuplicatePair).join('');
    return `
        <div class="openvault-dup-summary-bar">
            <span><i class="fa-solid fa-user-group"></i> ${pairs.length} possible duplicate character${pairs.length !== 1 ? 's' : ''} found</span>
        </div>
        <div class="openvault-dup-list">
            ${rows}
        </div>
        <div class="openvault-char-dup-divider"></div>
    `;
}

/**
 * Render the full duplicates review panel (character merges + memory near-dupes).
 * @param {HTMLElement} container - The container element to render into
 */
export function renderDuplicatesPanel(container) {
    if (typeof container === 'string') {
        container = document.querySelector(container) || document.getElementById(container);
    }
    if (!container) return;

    const charSection = renderCharacterDuplicatesSection();
    const candidates = findNearDuplicates();

    if (!charSection && candidates.length === 0) {
        container.innerHTML = `
            <div class="openvault-dup-empty">
                <i class="fa-solid fa-circle-check" style="font-size: 2em; color: var(--SmartThemeQuoteColor);"></i>
                <p>No duplicates found</p>
                <small>All characters and memories appear to be distinct.</small>
            </div>
        `;
        return;
    }

    const memorySection =
        candidates.length > 0
            ? `
        <div class="openvault-dup-summary-bar">
            <span><i class="fa-solid fa-clone"></i> ${candidates.length} near-duplicate pair${candidates.length !== 1 ? 's' : ''} found</span>
        </div>
        <div class="openvault-dup-list">
            ${candidates.map((c, i) => renderDuplicatePair(c, i)).join('')}
        </div>
    `
            : '';

    container.innerHTML = charSection + memorySection;
}

// =============================================================================
// Actions
// =============================================================================

/**
 * Handle duplicate review actions.
 * @param {string} action - 'keep-a', 'keep-b', 'skip', 'merge'
 * @param {number} index - Candidate index
 */
export async function handleDuplicateAction(action, index) {
    const candidates = findNearDuplicates();
    const candidate = candidates[index];
    if (!candidate) {
        showToast('warning', 'Duplicate pair no longer available');
        return;
    }

    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return;
    }

    const { a, b } = candidate;

    try {
        if (action === 'keep-a') {
            // Delete B, keep A
            await deleteMemoryAction(b.id);
            showToast('success', 'Kept Memory A, deleted Memory B');
        } else if (action === 'keep-b') {
            // Delete A, keep B
            await deleteMemoryAction(a.id);
            showToast('success', 'Kept Memory B, deleted Memory A');
        } else if (action === 'skip') {
            // Archive both so they don't show up again in future scans
            const memories = data[MEMORIES_KEY];
            const memA = memories?.find((m) => m.id === a.id);
            const memB = memories?.find((m) => m.id === b.id);
            if (memA) memA._dup_reviewed = true;
            if (memB) memB._dup_reviewed = true;
            await saveOpenVaultData();
            showToast('info', 'Pair skipped (both kept)');
        } else if (action === 'merge') {
            // Merge: increment B's mentions by A's, add A's characters to B, link in summary
            const memories = data[MEMORIES_KEY];
            const memA = memories?.find((m) => m.id === a.id);
            const memB = memories?.find((m) => m.id === b.id);
            if (memA && memB) {
                memB.mentions = (memB.mentions || 1) + (memA.mentions || 1);
                // Merge characters_involved
                const mergedChars = new Set([...(memB.characters_involved || []), ...(memA.characters_involved || [])]);
                memB.characters_involved = [...mergedChars];
                // Append A's summary as context
                if (memA.summary) {
                    memB.summary = memB.summary + ' (also: ' + memA.summary + ')';
                }
                memA._dup_reviewed = true;
                memB._dup_reviewed = true;
                await saveOpenVaultData();
                showToast('success', "Memories merged (both kept, B enriched with A's context)");
            }
        }

        // Re-render the duplicates panel
        const container = document.getElementById('openvault_duplicates_content');
        if (container) {
            renderDuplicatesPanel(container);
        }
    } catch (err) {
        console.error('[OpenVault] Duplicate action failed:', err);
        showToast('error', `Action failed: ${err.message}`);
    }
}

/**
 * Merge one suggested duplicate character into another, by display name.
 *
 * Handles every combination of which side has a graph node:
 *  - both are graph entities  -> mergeEntities (merges graph + reconciles stores)
 *  - only the absorbed side has a node (survivor is state-only) -> reconcile the
 *    name-keyed stores, then RENAME the absorbed node onto the survivor's name so
 *    its description/edges aren't orphaned under a now-dead name
 *  - only the survivor has a node, or neither does -> reconcile the name-keyed
 *    stores directly (no graph node to move)
 *
 * @param {string} sourceName - Display name of the character to absorb
 * @param {string} targetName - Display name of the surviving character
 */
export async function handleCharacterMerge(sourceName, targetName) {
    if (!sourceName || !targetName || sourceName.toLowerCase() === targetName.toLowerCase()) return;
    try {
        const data = getOpenVaultData();
        if (!data) {
            showToast('warning', 'No chat loaded');
            return;
        }
        const nodes = data.graph?.nodes || {};
        const sourceKey = normalizeKey(sourceName);
        const targetKey = normalizeKey(targetName);
        const sourceHasNode = !!nodes[sourceKey];
        const targetHasNode = !!nodes[targetKey];

        let stChanges = null;

        if (sourceHasNode && targetHasNode && sourceKey !== targetKey) {
            // Both are graph entities — full graph + state merge.
            const result = await mergeEntities(sourceKey, targetKey);
            if (!result?.success) {
                showToast('error', 'Failed to merge characters');
                return;
            }
            stChanges = result.stChanges;
        } else {
            // At most one side is a graph entity — reconcile the name-keyed stores.
            reconcileCharacterIdentity(data, sourceName, targetName);
            // If the absorbed name owns the only graph node (survivor is state-only),
            // rename that node onto the survivor so its description/edges survive and
            // the absorbed name stops being re-detected as a duplicate.
            if (sourceHasNode && !targetHasNode && sourceKey !== targetKey) {
                const result = await updateEntity(sourceKey, { name: targetName });
                stChanges = result?.stChanges ?? null;
            }
            await saveOpenVaultData();
        }

        if (stChanges) {
            const { applySyncChanges } = await import('../extraction/extract.js');
            await applySyncChanges(stChanges);
        }

        showToast('success', `Merged "${sourceName}" → "${targetName}"`);
        const container = document.getElementById('openvault_duplicates_content');
        if (container) renderDuplicatesPanel(container);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('[OpenVault] Character merge failed:', err);
            showToast('error', `Merge failed: ${err.message}`);
        }
    }
}

/**
 * Dismiss a suggested character merge — records that the two characters are
 * distinct ("not the same person") so the pair stops being re-suggested.
 * @param {string} sourceName - First character display name
 * @param {string} targetName - Second character display name
 */
export async function handleCharacterDismiss(sourceName, targetName) {
    if (!sourceName || !targetName) return;
    try {
        const changed = await dismissCharacterMerge(sourceName, targetName);
        showToast('info', changed ? 'Marked as not the same person' : 'Already dismissed');
        const container = document.getElementById('openvault_duplicates_content');
        if (container) renderDuplicatesPanel(container);
    } catch (err) {
        console.error('[OpenVault] Character dismiss failed:', err);
        showToast('error', `Dismiss failed: ${err.message}`);
    }
}

/**
 * Rename a character to its full name (e.g. "Marcus" → "Marcus Williams").
 * Prompts for the new name, then migrates it across every identity store.
 * @param {string} oldName - Current character display name
 */
export async function handleCharacterRename(oldName) {
    if (!oldName) return;
    const newName = window.prompt(`Rename "${oldName}" to its full name:`, oldName);
    if (newName === null) return; // cancelled
    const trimmed = String(newName).trim();
    if (!trimmed || trimmed.toLowerCase() === String(oldName).toLowerCase()) return;
    try {
        const result = await renameCharacter(oldName, trimmed);
        if (!result?.success) {
            if (result?.collision) {
                showToast('warning', `"${trimmed}" already exists — use Merge to combine them instead`);
            } else {
                showToast('error', 'Failed to rename character');
            }
            return;
        }
        if (result.stChanges) {
            const { applySyncChanges } = await import('../extraction/extract.js');
            await applySyncChanges(result.stChanges);
        }
        showToast('success', `Renamed "${oldName}" → "${trimmed}"`);
        const container = document.getElementById('openvault_duplicates_content');
        if (container) renderDuplicatesPanel(container);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('[OpenVault] Character rename failed:', err);
            showToast('error', `Rename failed: ${err.message}`);
        }
    }
}

/**
 * Bind duplicate review events to a container element.
 * @param {HTMLElement|JQuery} $container - jQuery or DOM element
 */
export const renderDuplicatePanel = renderDuplicatesPanel;

/**
 * Bind duplicate review events to a container element.
 * @param {HTMLElement|JQuery} $container - jQuery or DOM element
 */
export function bindDuplicateEvents($container) {
    $container = $container.jquery ? $container : $($container);

    $container.on('click', '.openvault-char-merge-confirm', function () {
        const sourceName = $(this).data('source-name');
        const targetName = $(this).data('target-name');
        handleCharacterMerge(String(sourceName ?? ''), String(targetName ?? ''));
    });

    $container.on('click', '.openvault-char-dismiss-btn', function () {
        const sourceName = $(this).data('source-name');
        const targetName = $(this).data('target-name');
        handleCharacterDismiss(String(sourceName ?? ''), String(targetName ?? ''));
    });

    $container.on('click', '.openvault-char-rename-btn', function () {
        const name = $(this).data('rename-name');
        handleCharacterRename(String(name ?? ''));
    });

    $container.on('click', '.openvault-dup-action-btn', function () {
        const action = $(this).data('action');
        const index = parseInt($(this).data('index'), 10);
        if (!action || Number.isNaN(index)) return;
        handleDuplicateAction(action, index);
    });
}

/**
 * Refresh the duplicates tab content.
 */
export async function refreshDuplicatesTab() {
    const container = document.getElementById('openvault_duplicates_content');
    if (!container) return;
    renderDuplicatesPanel(container);
}
