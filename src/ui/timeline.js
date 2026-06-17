/**
 * OpenVault Memory Timeline View
 *
 * Chronological timeline showing when memories happened relative to the conversation.
 * Uses temporal_anchor fields and message_ids to position events in narrative flow.
 *
 * Inline Summary Compatibility:
 * When Inline Summary replaces messages with a summary, original message IDs become orphaned.
 * Memories with orphaned IDs are sorted by created_at timestamp instead of messageId,
 * and marked with a visual indicator.
 */

import { extensionName, MEMORIES_KEY } from '../constants.js';
import { getDeps } from '../deps.js';
import { getFingerprint } from '../extraction/scheduler.js';
import { deleteMemory, getOpenVaultData, updateMemory } from '../store/chat-data.js';
import { escapeHtml, showToast } from '../utils/dom.js';
import { formatMemoryDate, formatMemoryImportance, getTransientDecayInfo } from './helpers.js';
import { renderMemoryEdit } from './templates.js';

// =============================================================================
// Data Processing
// =============================================================================

/**
 * Determine whether a memory is orphaned — its source messages no longer exist
 * in the current chat (typically because Inline Summary compressed the range
 * into a placeholder). Prefers `message_fingerprints` (stable across chat
 * mutations); falls back to `message_ids` only for unmigrated v2 data.
 *
 * @param {Object} memory - Memory record
 * @param {Map<string, number>} fpMap - Map of current chat fingerprint → index
 * @param {number} chatLength - Number of messages in the current chat
 * @returns {boolean} True if the memory's source is no longer in the chat
 */
function isMemoryOrphaned(memory, fpMap, chatLength) {
    // Chat not loaded yet — can't determine. Don't mass-flag everything as orphaned.
    if (chatLength === 0) return false;

    if (memory.message_fingerprints?.length > 0) {
        const anyResolves = memory.message_fingerprints.some((fp) => fpMap.has(fp));
        return !anyResolves;
    }

    // Legacy fallback: index-based check for pre-fingerprint memories
    const rawMessageId = memory.message_ids?.[0] || memory.message_id || 0;
    if (rawMessageId <= 0) return false;
    return rawMessageId >= chatLength;
}

/**
 * Build timeline entries from memories with temporal anchors and message IDs.
 * Handles Inline Summary compatibility by detecting orphaned message IDs.
 * @returns {Array<{ id: string, summary: string, importance: number, type: string, messageId: number, temporalAnchor: string|null, characters: string[], timestamp: number, isReflection: boolean, isTransient: boolean, isOrphaned: boolean }>}
 */
function buildTimelineEntries() {
    const data = getOpenVaultData();
    const memories = data?.[MEMORIES_KEY] || [];
    if (memories.length === 0) return [];

    // Build a fingerprint→index map from the current chat. Used for orphan
    // detection (the canonical signal — see retrieval/retrieve.js#_getHiddenMemories).
    const context = getDeps().getContext();
    const chat = context?.chat || [];
    const fpMap = new Map();
    for (let i = 0; i < chat.length; i++) {
        fpMap.set(getFingerprint(chat[i]), i);
    }

    // Pull live decay settings so the transient badge reflects the user's actual
    // config, plus the current extraction-axis anchor for remaining-lifespan calc.
    const settings = getDeps().getExtensionSettings()?.[extensionName] || {};
    const baseLambda = settings.forgetfulnessBaseLambda ?? 0.05;
    const transientMultiplier = settings.transientDecayMultiplier ?? 5.0;
    const currentExtractionCount = typeof data?.graph_message_count === 'number' ? data.graph_message_count : null;

    const entries = memories
        .filter((m) => !m.archived)
        .map((m) => {
            const rawMessageId = m.message_ids?.[0] || m.message_id || 0;
            const isOrphaned = isMemoryOrphaned(m, fpMap, chat.length);
            const decay = m.is_transient
                ? getTransientDecayInfo(m, baseLambda, transientMultiplier, currentExtractionCount)
                : { label: '', halfLife: 0, remaining: null };

            return {
                id: m.id,
                summary: m.summary || 'No summary',
                importance: m.importance || 3,
                type: m.type || 'event',
                messageId: rawMessageId,
                temporalAnchor: m.temporal_anchor || null,
                characters: m.characters_involved || m.witnesses || [],
                timestamp: m.created_at || m.timestamp || 0,
                isReflection: m.type === 'reflection',
                isTransient: m.is_transient || false,
                transientDecay: decay.label,
                transientHalfLife: decay.halfLife,
                transientRemaining: decay.remaining,
                mentions: m.mentions || 1,
                level: m.level || undefined,
                isOrphaned: isOrphaned,
            };
        });

    // Sort by messageId ascending (chronological), with orphaned entries sorted by timestamp
    entries.sort((a, b) => {
        // Both have valid messageIds - sort by messageId
        if (a.messageId > 0 && !a.isOrphaned && b.messageId > 0 && !b.isOrphaned) {
            return a.messageId - b.messageId;
        }
        // Both orphaned or no messageId - sort by timestamp
        if ((a.isOrphaned || a.messageId === 0) && (b.isOrphaned || b.messageId === 0)) {
            return a.timestamp - b.timestamp;
        }
        // One orphaned, one not - orphaned goes by timestamp comparison
        // Put orphaned entries near their timestamp-equivalent position
        if (a.isOrphaned || a.messageId === 0) {
            return 1; // Orphaned entries go later (they're from summarized content)
        }
        return -1;
    });

    return entries;
}

/**
 * Group timeline entries by conversation phase.
 * @param {Array} entries - Timeline entries sorted by messageId
 * @returns {Array<{ label: string, entries: Array, startMsg: number, endMsg: number }>}
 */
function groupByPhase(entries) {
    if (entries.length === 0) return [];

    // Simple grouping: every ~20 messages = a phase, or by temporal anchor
    const groups = [];
    let currentGroup = null;
    let phaseCounter = 1;

    for (const entry of entries) {
        const msgId = entry.messageId;

        // For orphaned entries or entries without messageId, use a special group
        if (entry.isOrphaned || msgId === 0) {
            // Add to current group or create "Summarized" group
            if (!currentGroup || currentGroup.groupIndex !== -1) {
                if (currentGroup) {
                    groups.push(currentGroup);
                }
                currentGroup = {
                    label: 'Summarized / Archived',
                    groupIndex: -1,
                    entries: [],
                    startMsg: -1,
                    endMsg: -1,
                    isSummarized: true,
                };
            }
            currentGroup.entries.push(entry);
            continue;
        }

        // Start a new group if this is the first entry, or if we've crossed a 20-message boundary
        const groupIndex = Math.floor(msgId / 20);

        if (!currentGroup || currentGroup.groupIndex !== groupIndex) {
            if (currentGroup) {
                groups.push(currentGroup);
            }
            currentGroup = {
                label: `Phase ${phaseCounter}`,
                groupIndex,
                entries: [],
                startMsg: Math.floor(msgId / 20) * 20,
                endMsg: Math.floor(msgId / 20) * 20 + 19,
            };
            phaseCounter++;
        }

        currentGroup.entries.push(entry);
        currentGroup.endMsg = Math.max(currentGroup.endMsg, msgId);
    }

    if (currentGroup) {
        groups.push(currentGroup);
    }

    // Use temporal anchors for group labels if available
    for (const group of groups) {
        if (group.isSummarized) continue; // Keep "Summarized" label
        const anchors = group.entries.filter((e) => e.temporalAnchor).map((e) => e.temporalAnchor);
        if (anchors.length > 0) {
            // Use the first temporal anchor as the phase label
            group.label = anchors[0];
        }
    }

    return groups;
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Render a single timeline entry.
 * @param {Object} entry
 * @param {number} index
 * @param {number} total
 * @returns {string} HTML string
 */
function renderTimelineEntry(entry, index, total) {
    const isLast = index === total - 1;
    const stars = formatMemoryImportance(entry.importance);
    const typeBadge = entry.isReflection
        ? '<span class="openvault-timeline-badge reflection"><i class="fa-solid fa-lightbulb"></i> Reflection</span>'
        : '';
    const isFaded = entry.transientRemaining !== null && entry.transientRemaining < 0.5;
    const transientBadge = entry.isTransient
        ? `<span class="openvault-timeline-badge transient${isFaded ? ' faded' : ''}" title="Half-life: ${entry.transientHalfLife.toFixed(1)} extractions"><i class="fa-solid fa-wind"></i> ${escapeHtml(entry.transientDecay || 'Transient')}</span>`
        : '';
    const orphanedBadge = entry.isOrphaned
        ? '<span class="openvault-timeline-badge orphaned" title="Original message was summarized by Inline Summary"><i class="fa-solid fa-compress"></i> Summarized</span>'
        : '';
    const dateLabel = entry.timestamp ? formatMemoryDate(entry.timestamp) : '';
    const anchorLabel = entry.temporalAnchor
        ? `<span class="openvault-timeline-anchor"><i class="fa-solid fa-clock"></i> ${escapeHtml(entry.temporalAnchor)}</span>`
        : '';
    const charTags =
        entry.characters.length > 0
            ? `<div class="openvault-timeline-chars">${entry.characters.map((c) => `<span class="openvault-character-tag">${escapeHtml(c)}</span>`).join('')}</div>`
            : '';

    return `
        <div class="openvault-timeline-entry ${entry.isReflection ? 'reflection' : ''} ${entry.isTransient ? 'transient' : ''} ${entry.isOrphaned ? 'orphaned' : ''}">
            <div class="openvault-timeline-node">
                <div class="openvault-timeline-dot ${entry.isReflection ? 'reflection' : ''} ${entry.isOrphaned ? 'orphaned' : ''}"></div>
                ${!isLast ? '<div class="openvault-timeline-line"></div>' : ''}
            </div>
            <div class="openvault-timeline-content">
                <div class="openvault-timeline-header">
                    <span class="openvault-timeline-importance">${stars}</span>
                    ${typeBadge}
                    ${transientBadge}
                    ${orphanedBadge}
                    <span class="openvault-timeline-date">${escapeHtml(dateLabel)}</span>
                    ${anchorLabel}
                    <span class="openvault-timeline-actions" style="margin-left: auto;">
                        <button class="openvault-timeline-edit-btn" data-id="${escapeHtml(entry.id)}" title="Edit this memory">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="openvault-timeline-delete-btn" data-id="${escapeHtml(entry.id)}" title="Delete this memory">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </span>
                </div>
                <div class="openvault-timeline-summary">${escapeHtml(entry.summary)}</div>
                ${charTags}
                ${entry.level ? `<div class="openvault-timeline-level">Level ${entry.level} reflection</div>` : ''}
            </div>
        </div>
    `;
}

/**
 * Render a phase group header.
 * @param {Object} group
 * @returns {string} HTML string
 */
function renderPhaseHeader(group) {
    const count = group.entries.length;
    const rangeText = group.isSummarized
        ? 'Original messages summarized'
        : `Messages ${group.startMsg}–${group.endMsg}`;

    return `
        <div class="openvault-timeline-phase ${group.isSummarized ? 'summarized' : ''}">
            <div class="openvault-timeline-phase-header">
                <span class="openvault-timeline-phase-label">${escapeHtml(group.label)}</span>
                <span class="openvault-timeline-phase-range">${rangeText}</span>
                <span class="openvault-timeline-phase-count">${count} memor${count !== 1 ? 'ies' : 'y'}</span>
            </div>
        </div>
    `;
}

/**
 * Render the timeline toolbar with refresh button.
 * @param {number} entryCount - Total number of entries
 * @param {number} orphanedCount - Number of orphaned entries
 * @returns {string} HTML string
 */
function renderTimelineToolbar(_entryCount, orphanedCount) {
    const orphanedWarning =
        orphanedCount > 0
            ? `<span class="openvault-timeline-orphaned-warning" title="${orphanedCount} memories reference messages that were summarized by Inline Summary">
            <i class="fa-solid fa-triangle-exclamation"></i> ${orphanedCount} Summarized
           </span>`
            : '';

    return `
        <div class="openvault-timeline-toolbar">
            <button class="openvault-timeline-refresh-btn" title="Refresh timeline">
                <i class="fa-solid fa-arrows-rotate"></i> Refresh
            </button>
            ${orphanedWarning}
        </div>
    `;
}

/**
 * Render the full timeline.
 * @param {HTMLElement|string} container - DOM element or selector
 */
export function renderTimeline(container) {
    if (typeof container === 'string') {
        container = document.querySelector(container) || document.getElementById(container);
    }
    if (!container) return;

    const entries = buildTimelineEntries();

    if (entries.length === 0) {
        container.innerHTML = `
            <div class="openvault-timeline-empty">
                <i class="fa-solid fa-timeline" style="font-size: 2em; color: var(--SmartThemeQuoteColor);"></i>
                <p>No timeline entries yet</p>
                <small>Extract memories from your conversation to populate the timeline.</small>
            </div>
        `;
        return;
    }

    const groups = groupByPhase(entries);
    const orphanedCount = entries.filter((e) => e.isOrphaned).length;

    let html = renderTimelineToolbar(entries.length, orphanedCount);

    html += `
        <div class="openvault-timeline-summary-bar">
            <span><i class="fa-solid fa-stream"></i> ${entries.length} memories across ${groups.length} phase${groups.length !== 1 ? 's' : ''}</span>
            <span class="openvault-timeline-legend">
                <span class="openvault-timeline-legend-item"><span class="openvault-timeline-dot"></span> Event</span>
                <span class="openvault-timeline-legend-item"><span class="openvault-timeline-dot reflection"></span> Reflection</span>
                <span class="openvault-timeline-legend-item"><span class="openvault-timeline-dot transient"></span> Transient</span>
                ${orphanedCount > 0 ? '<span class="openvault-timeline-legend-item"><span class="openvault-timeline-dot orphaned"></span> Archived</span>' : ''}
            </span>
        </div>
        <div class="openvault-timeline-track">
    `;

    for (const group of groups) {
        html += renderPhaseHeader(group);
        html += group.entries.map((entry, idx) => renderTimelineEntry(entry, idx, group.entries.length)).join('');
    }

    html += '</div>';

    container.innerHTML = html;
}

export const renderTimelinePanel = renderTimeline;

/**
 * Refresh the timeline tab content.
 */
export function refreshTimelineTab() {
    const container = document.getElementById('openvault_timeline_content');
    if (container) {
        renderTimeline(container);
    }
}

/**
 * Setup timeline tab events.
 * @param {JQuery|HTMLElement} $container
 */
export function bindTimelineEvents($container) {
    $container = $container.jquery ? $container : $($container);

    // Click on a timeline entry to expand/collapse details
    $container.on('click', '.openvault-timeline-entry', function () {
        $(this).toggleClass('expanded');
    });

    // Refresh button
    $container.on('click', '.openvault-timeline-refresh-btn', function () {
        const $btn = $(this);
        const $icon = $btn.find('i');

        // Add spinning animation
        $icon.addClass('fa-spin');
        $btn.prop('disabled', true);

        // Refresh the timeline
        refreshTimelineTab();

        // Remove animation after a short delay
        setTimeout(() => {
            $icon.removeClass('fa-spin');
            $btn.prop('disabled', false);
            showToast('success', 'Timeline refreshed');
        }, 300);
    });

    // Edit button on timeline entries
    $container.on('click', '.openvault-timeline-edit-btn', async function (e) {
        e.stopPropagation();
        const id = $(this).data('id');
        if (!id) return;

        const data = getOpenVaultData();
        const memory = data?.[MEMORIES_KEY]?.find((m) => m.id === id);
        if (!memory) return;

        const $entry = $(this).closest('.openvault-timeline-entry');
        $entry.addClass('editing');
        $entry.find('.openvault-timeline-content').replaceWith(`
            <div class="openvault-timeline-content">
                ${renderMemoryEdit(memory)}
            </div>
        `);
    });

    // Cancel edit on timeline entries
    $container.on('click', '.openvault-cancel-edit', function (e) {
        e.stopPropagation();
        const _id = $(this).data('id');
        refreshTimelineTab();
    });

    // Save edit on timeline entries
    $container.on('click', '.openvault-save-edit', async function (e) {
        e.stopPropagation();
        const id = $(this).data('id');
        const $card = $(this).closest('.openvault-memory-card[data-id="' + id + '"]');
        const $btn = $(this);

        const summary = $card.find('[data-field="summary"]').val().trim();
        const importance = parseInt($card.find('[data-field="importance"]').val(), 10);
        const temporal_anchor = $card.find('[data-field="temporal_anchor"]').val().trim() || null;
        const is_transient = $card.find('[data-field="is_transient"]').is(':checked');
        const witnessesRaw = $card.find('[data-field="witnesses"]').val()?.toString()?.trim() || '';
        const witnesses = witnessesRaw
            ? witnessesRaw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : [];

        if (!summary) {
            showToast('warning', 'Summary cannot be empty');
            return;
        }

        $btn.prop('disabled', true);
        try {
            const result = await updateMemory(id, {
                summary,
                importance,
                temporal_anchor,
                is_transient,
                witnesses,
                characters_involved: witnesses,
            });
            if (result?.success) {
                if (result.stChanges) {
                    const { applySyncChanges } = await import('../extraction/extract.js');
                    await applySyncChanges(result.stChanges);
                }
                showToast('success', 'Memory updated');
                refreshTimelineTab();
            } else {
                showToast('error', 'Failed to update memory');
                $btn.prop('disabled', false);
            }
        } catch (err) {
            console.error('[OpenVault] Timeline save error:', err);
            showToast('error', `Save failed: ${err.message}`);
            $btn.prop('disabled', false);
        }
    });

    // Delete button on timeline entries
    $container.on('click', '.openvault-timeline-delete-btn', async function (e) {
        e.stopPropagation();
        const id = $(this).data('id');
        if (!id) return;
        if (!confirm('Delete this memory? This cannot be undone.')) return;

        try {
            const result = await deleteMemory(id);
            if (result?.success) {
                $(this)
                    .closest('.openvault-timeline-entry')
                    .fadeOut(200, function () {
                        $(this).remove();
                    });
                showToast('success', 'Memory deleted from timeline');
            } else {
                showToast('error', 'Failed to delete memory');
            }
        } catch (err) {
            console.error('[OpenVault] Timeline delete error:', err);
            showToast('error', `Delete failed: ${err.message}`);
        }
    });
}
