/**
 * OpenVault Conflict/Duplicate Resolution UI
 *
 * Panel for reviewing near-duplicate memories that were flagged during dedup.
 * Shows the original and duplicate side-by-side with accept/reject actions.
 */

import { MEMORIES_KEY } from '../constants.js';
import { getOpenVaultData, deleteMemory as deleteMemoryAction, saveOpenVaultData } from '../store/chat-data.js';
import { escapeHtml, showToast } from '../utils/dom.js';

// =============================================================================
// Data Access
// =============================================================================

/**
 * Get all non-archived memories sorted by mentions (descending).
 * @returns {Object[]}
 */
function getAllMemories() {
    const data = getOpenVaultData();
    return (data?.[MEMORIES_KEY] || [])
        .filter((m) => !m.archived);
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

            // Skip if already reviewed (both archived)
            if (a.archived && b.archived) continue;

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
 * Render the full duplicates review panel.
 * @param {HTMLElement} container - The container element to render into
 */
export function renderDuplicatesPanel(container) {
    if (typeof container === 'string') {
        container = document.querySelector(container) || document.getElementById(container);
    }
    if (!container) return;

    const candidates = findNearDuplicates();

    if (candidates.length === 0) {
        container.innerHTML = `
            <div class="openvault-dup-empty">
                <i class="fa-solid fa-circle-check" style="font-size: 2em; color: var(--SmartThemeQuoteColor);"></i>
                <p>No near-duplicate memories found</p>
                <small>All memories appear to be sufficiently distinct.</small>
            </div>
        `;
        return;
    }

    const pairs = candidates.map((c, i) => renderDuplicatePair(c, i)).join('');

    container.innerHTML = `
        <div class="openvault-dup-summary-bar">
            <span><i class="fa-solid fa-clone"></i> ${candidates.length} near-duplicate pair${candidates.length !== 1 ? 's' : ''} found</span>
        </div>
        <div class="openvault-dup-list">
            ${pairs}
        </div>
    `;
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
                showToast('success', 'Memories merged (both kept, B enriched with A\'s context)');
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

    $container.on('click', '.openvault-dup-action-btn', function () {
        const action = $(this).data('action');
        const index = parseInt($(this).data('index'), 10);
        if (!action || isNaN(index)) return;
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