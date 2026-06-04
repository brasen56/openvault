/**
 * OpenVault Side Panel
 *
 * Persistent panel on the left side of the chat showing memories,
 * communities, and entities with infinite scroll.
 */

import { CHARACTERS_KEY, extensionFolderPath, MEMORIES_KEY, UI_DEFAULT_HINTS } from '../constants.js';
import {
    archiveMemories,
    deleteCommunity,
    deleteEntity as deleteEntityAction,
    deleteMemories as deleteMemoriesBulk,
    deleteMemory as deleteMemoryAction,
    getOpenVaultData,
    mergeEntities,
    unarchiveMemories,
    updateCommunity,
    updateEntity,
    updateMemory as updateMemoryAction,
} from '../store/chat-data.js';
import { escapeHtml, showToast } from '../utils/dom.js';
import { bindDuplicateEvents, renderDuplicatePanel } from './duplicates.js';
import {
    buildUserExportPayload,
    exportMemoriesToFile,
    heuristicReclassifyTransient,
    llmReclassifyLastN,
    llmReclassifyTransient,
    openImportPicker,
    renderExportImportPanel,
} from './export-import.js';
import { renderGraphViz, stopSimulation } from './graph-viz.js';
import {
    buildCharacterStateData,
    filterEntities,
    filterMemories,
    formatMemoryDate,
    formatMemoryImportance,
    sortMemories,
} from './helpers.js';
import { populateFilter } from './render.js';
import {
    bindSidePanelContradictionSettings,
    bindSidePanelGeneralSettings,
    updateSidePanelContradictionSettings,
    updateSidePanelGeneralSettings,
} from './settings.js';
import { refreshStats } from './status.js';
import {
    renderCharacterState,
    renderEntityCard,
    renderEntityEdit,
    renderEntityMergePicker,
    renderMemoryEdit,
} from './templates.js';
import { bindTimelineEvents, renderTimelinePanel } from './timeline.js';
import { renderInjectionPreview } from './transparency.js';

let _initialized = false;
let _entitySearchTimeout = null;

// =============================================================================
// Initialization
// =============================================================================

export async function initSidePanel() {
    if (_initialized) return;

    const html = await $.get(`${extensionFolderPath}/templates/side_panel.html`);
    $('body').append(html);

    bindSidePanelEvents();

    // Handle "View in Panel" from extraction notifications
    $(document).on('openvault:view-recent', () => {
        openSidePanel();
        // Switch to memories tab
        const $memTab = $('#openvault_side_panel').find('.openvault-side-tab[data-side-tab="memories"]');
        if ($memTab.length && !$memTab.hasClass('active')) {
            $memTab.trigger('click');
        }
    });

    _initialized = true;
}

function bindSidePanelEvents() {
    const $panel = $('#openvault_side_panel');

    // Tab switching
    $panel.on('click', '.openvault-side-tab', function () {
        const tabId = $(this).data('side-tab');
        $('.openvault-side-tab').removeClass('active');
        $(this).addClass('active');
        $('.openvault-side-tab-content').removeClass('active');
        $(`.openvault-side-tab-content[data-side-tab-content="${tabId}"]`).addClass('active');

        // Render graph when switching to the graph tab
        if (tabId === 'graph') {
            renderGraphViz();
        } else {
            stopSimulation();
        }

        // Render content for new tabs on switch
        if (tabId === 'timeline') {
            renderTimelinePanel('#openvault_timeline_content');
        } else if (tabId === 'duplicates') {
            renderDuplicatePanel(document.getElementById('openvault_duplicates_content'));
        } else if (tabId === 'injection') {
            renderInjectionPreview($('#openvault_injection_preview'));
        } else if (tabId === 'export-import') {
            renderExportImportPanel(document.getElementById('openvault_export_import_content'));
        } else if (tabId === 'manage') {
            renderSideManage();
        }
    });

    // Close button
    $panel.on('click', '#openvault_side_panel_close', () => {
        closeSidePanel();
    });

    // Entity filters
    $panel.on('input', '#openvault_side_entity_search', () => {
        clearTimeout(_entitySearchTimeout);
        _entitySearchTimeout = setTimeout(renderSideEntities, 200);
    });
    $panel.on('change', '#openvault_side_entity_type', renderSideEntities);
    $panel.on('change', '#openvault_side_entity_search_scope', renderSideEntities);

    // Memory actions (scoped to sidebar so they don't conflict with main panel)
    $panel.on('click', '.openvault-delete-memory', async (e) => {
        const id = $(e.currentTarget).data('id');
        if (!confirm('Delete this memory?')) return;
        const result = await deleteMemoryAction(id);
        if (result.success) {
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            renderSideMemories();
            showToast('success', 'Memory deleted');
        }
    });

    $panel.on('click', '.openvault-edit-memory', (e) => {
        const id = $(e.currentTarget).data('id');
        const memory = getSideMemoryById(id);
        if (!memory) return;
        const $card = $panel.find(`.openvault-memory-card[data-id="${id}"]`);
        $card.replaceWith(renderMemoryEdit(memory));
    });

    $panel.on('click', '.openvault-cancel-edit', (e) => {
        const id = $(e.currentTarget).data('id');
        const memory = getSideMemoryById(id);
        if (!memory) return;
        const $card = $panel.find(`.openvault-memory-card[data-id="${id}"]`);
        $card.replaceWith(renderSideMemoryItem(memory));
    });

    $panel.on('click', '.openvault-save-edit', async (e) => {
        const id = $(e.currentTarget).data('id');
        const $card = $panel.find(`.openvault-memory-card[data-id="${id}"]`);
        const $btn = $(e.currentTarget);

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
        const result = await updateMemoryAction(id, {
            summary,
            importance,
            temporal_anchor,
            is_transient,
            witnesses,
            characters_involved: witnesses,
        });
        if (result.success) {
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            const updated = getSideMemoryById(id);
            if (updated) {
                $card.replaceWith(renderSideMemoryItem(updated));
            }
            showToast('success', 'Memory updated');
        }
        $btn.prop('disabled', false);
    });

    // =========================================================================
    // Entity actions (scoped to sidebar)
    // =========================================================================

    $panel.on('click', '.openvault-edit-entity', (e) => {
        const key = $(e.currentTarget).data('key');
        const graph = getOpenVaultData()?.graph;
        const entity = graph?.nodes?.[key];
        if (!entity) return;
        const $card = $panel.find(`.openvault-entity-card[data-key="${key}"]`);
        $card.replaceWith(renderEntityEdit(entity, key));
    });

    $panel.on('click', '.openvault-cancel-entity-edit', (e) => {
        const key = $(e.currentTarget).data('key');
        const entity = getOpenVaultData()?.graph?.nodes?.[key];
        if (!entity) return;
        const $edit = $panel.find(`.openvault-entity-edit[data-key="${key}"]`);
        $edit.replaceWith(renderEntityCard(entity, key));
    });

    $panel.on('click', '.openvault-save-entity-edit', async (e) => {
        const key = $(e.currentTarget).data('key');
        const $edit = $panel.find(`.openvault-entity-edit[data-key="${key}"]`);
        const name = $edit.find('.openvault-edit-name').val()?.toString().trim();
        const type = $edit.find('.openvault-edit-type').val()?.toString();
        const description = $edit.find('.openvault-edit-description').val()?.toString().trim();

        if (!name) {
            showToast('warning', 'Entity name cannot be empty');
            return;
        }

        const aliases = $edit
            .find('.openvault-alias-chip')
            .map((_, chip) => $(chip).text().replace('×', '').trim())
            .get();
        const pending = $edit.find('.openvault-alias-input').val()?.toString()?.trim();
        if (pending && !aliases.map((a) => a.toLowerCase()).includes(pending.toLowerCase())) {
            aliases.push(pending);
        }

        const $btn = $(e.currentTarget);
        $btn.prop('disabled', true).text('Saving...');
        try {
            const result = await updateEntity(key, { name, type, description, aliases });
            if (result === null) {
                showToast('warning', 'An entity with that name already exists');
                $btn.prop('disabled', false).text('Save');
                return;
            }
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            const entity = getOpenVaultData().graph.nodes[result.key];
            $edit.replaceWith(renderEntityCard(entity, result.key));
            showToast('success', 'Entity updated');
            refreshStats();
        } catch (err) {
            console.error('[OpenVault] Failed to save entity:', err);
            $btn.prop('disabled', false).text('Save');
        }
    });

    $panel.on('click', '.openvault-delete-entity', async (e) => {
        const key = $(e.currentTarget).data('key');
        const graph = getOpenVaultData()?.graph;
        const entity = graph?.nodes?.[key];
        if (!entity) return;
        const edgeCount = Object.values(graph.edges || {}).filter(
            (ed) => ed.source === key || ed.target === key
        ).length;
        const msg =
            edgeCount > 0
                ? `Delete "${entity.name}"? This will also remove ${edgeCount} connected relationship(s).`
                : `Delete "${entity.name}"?`;
        if (!confirm(msg)) return;
        const result = await deleteEntityAction(key);
        if (result.success) {
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            $panel.find(`.openvault-entity-card[data-key="${key}"]`).remove();
            showToast('success', 'Entity deleted');
            refreshStats();
        }
    });

    $panel.on('click', '.openvault-remove-alias', function () {
        $(this).closest('.openvault-alias-chip').remove();
    });

    $panel.on('click', '.openvault-add-alias', (e) => {
        const key = $(e.currentTarget).data('key');
        const $edit = $panel.find(`.openvault-entity-edit[data-key="${key}"]`);
        const $input = $edit.find('.openvault-alias-input');
        const alias = $input.val()?.toString().trim();
        if (!alias) return;
        const existing = $edit
            .find('.openvault-alias-chip')
            .map((_, chip) => $(chip).text().replace('×', '').trim().toLowerCase())
            .get();
        if (existing.includes(alias.toLowerCase())) {
            $input.val('');
            return;
        }
        $edit.find('.openvault-alias-list').append(`
            <span class="openvault-alias-chip">
                ${escapeHtml(alias)}
                <span class="remove openvault-remove-alias" data-key="${escapeHtml(key)}" data-alias="${escapeHtml(alias)}">×</span>
            </span>
        `);
        $input.val('');
    });

    $panel.on('click', '.openvault-merge-entity', (e) => {
        const key = $(e.currentTarget).data('key');
        const graph = getOpenVaultData()?.graph;
        const node = graph?.nodes?.[key];
        if (!node) return;
        const $card = $panel.find(`.openvault-entity-card[data-key="${key}"]`);
        $card.replaceWith(renderEntityMergePicker(key, node, graph.nodes));
        $panel.find('.openvault-merge-search').focus();
    });

    $panel.on('click', '.openvault-cancel-entity-merge', () => {
        renderSideEntities();
    });

    $panel.on('click', '.openvault-confirm-entity-merge', async (e) => {
        const sourceKey = $(e.currentTarget).data('source-key');
        const graph = getOpenVaultData()?.graph;
        if (!graph) return;
        const inputText = $panel.find('.openvault-merge-search').val();
        const targetKey = findMergeTarget(inputText, graph.nodes);
        if (!targetKey) {
            showToast('error', 'Please select a valid target entity');
            return;
        }
        if (targetKey === sourceKey) {
            showToast('error', 'Cannot merge an entity into itself');
            return;
        }
        try {
            const result = await mergeEntities(sourceKey, targetKey);
            if (!result.success) {
                showToast('error', 'Failed to merge entities');
                return;
            }
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            renderSideEntities();
            showToast('success', `Merged into ${graph.nodes[targetKey]?.name || targetKey}`);
        } catch (err) {
            if (err.name !== 'AbortError') showToast('error', `Merge failed: ${err.message}`);
        }
    });

    // =========================================================================
    // Community actions (sidebar-only editing)
    // =========================================================================

    $panel.on('click', '.openvault-edit-community', (e) => {
        const id = $(e.currentTarget).data('id');
        const data = getOpenVaultData();
        const community = data?.communities?.[id];
        if (!community) return;
        const $item = $(e.currentTarget).closest('.openvault-community-item');
        $item.replaceWith(renderSideCommunityEdit(id, community));
    });

    $panel.on('click', '.openvault-cancel-community-edit', (e) => {
        const id = $(e.currentTarget).data('id');
        const community = getOpenVaultData()?.communities?.[id];
        if (!community) return;
        const $edit = $panel.find(`.openvault-community-editing[data-id="${id}"]`);
        $edit.replaceWith(renderSideCommunityCard(id, community));
    });

    $panel.on('click', '.openvault-save-community', async (e) => {
        const id = $(e.currentTarget).data('id');
        const $edit = $panel.find(`.openvault-community-editing[data-id="${id}"]`);
        const title = $edit.find('.openvault-community-edit-title').val().trim();
        const summary = $edit.find('.openvault-community-edit-summary').val().trim();
        if (!title) {
            showToast('warning', 'Title cannot be empty');
            return;
        }
        const result = await updateCommunity(id, { title, summary });
        if (result) {
            const community = getOpenVaultData()?.communities?.[id];
            $edit.replaceWith(renderSideCommunityCard(id, community));
            showToast('success', 'Community updated');
        }
    });

    $panel.on('click', '.openvault-delete-community', async (e) => {
        const id = $(e.currentTarget).data('id');
        const community = getOpenVaultData()?.communities?.[id];
        if (!community) return;
        if (!confirm(`Delete community "${community.title || id}"?`)) return;
        const result = await deleteCommunity(id);
        if (result) {
            $panel.find(`.openvault-community-item[data-id="${id}"]`).remove();
            showToast('success', 'Community deleted');
        }
    });

    // =========================================================================
    // Character state deletion
    // =========================================================================
    $panel.on('click', '.openvault-character-delete', async (e) => {
        e.stopPropagation();
        const charName = $(e.currentTarget).data('character');
        if (!charName) return;
        if (
            !confirm(
                `Remove "${charName}" from the vault character list? This will not affect memories — only the character state entry (emotion, known events) will be removed.`
            )
        )
            return;

        const { deleteCharacter } = await import('../store/chat-data.js');
        const result = await deleteCharacter(charName);
        if (result.success) {
            $(e.currentTarget).closest('.openvault-character-item').remove();
            showToast('success', `Removed "${charName}" from character list`);
        } else {
            showToast('error', `Failed to remove "${charName}"`);
        }
    });

    // =========================================================================
    // Timeline events (feature #9)
    // =========================================================================
    bindTimelineEvents($panel);

    // =========================================================================
    // Duplicate resolution events (feature #8)
    // =========================================================================
    bindDuplicateEvents($panel);

    // =========================================================================
    // Manage tab events
    // =========================================================================
    initManageTabEvents($panel);

    // =========================================================================
    // Export/Import events (feature #6)
    // =========================================================================
    $panel.on('click', '.openvault-export-import-btn', async function (_e) {
        const action = $(this).data('action');
        if (action === 'export') {
            exportMemoriesToFile();
        } else if (action === 'copy') {
            await handleCopyMemoryDatabase();
        } else if (action === 'import') {
            openImportPicker('merge');
        } else if (action === 'clear') {
            await handleClearMemoryDatabase();
        } else if (action === 'heuristic-reclassify') {
            await heuristicReclassifyTransient();
        } else if (action === 'llm-reclassify') {
            await llmReclassifyTransient();
        } else if (action === 'llm-reclassify-lastn') {
            const countInput = document.getElementById('openvault-reclassify-lastn-count');
            const n = countInput ? parseInt(countInput.value, 10) || 50 : 50;
            await llmReclassifyLastN(n);
        }
    });

    // =========================================================================
    // Side-panel Settings tab: Contradiction controls
    // =========================================================================
    // These bindings must be set up HERE (not in settings.js bindUIElements())
    // because the side panel HTML is injected by initSidePanel() AFTER
    // loadSettings() runs. The wiring uses event delegation rooted on $panel
    // so it survives any inner re-renders of the panel. We also push the
    // current settings values into the sliders/checkboxes so they reflect
    // persisted state immediately.
    bindSidePanelContradictionSettings($panel);
    bindSidePanelGeneralSettings($panel);
    updateSidePanelContradictionSettings();
    updateSidePanelGeneralSettings();

    // Populate default hints in side panel (e.g., "(default: 20)")
    $panel.find('.openvault-default-hint').each(function () {
        const key = $(this).data('default-key');
        const value = UI_DEFAULT_HINTS[key];
        if (value !== undefined) {
            $(this).text(` (default: ${value})`);
        }
    });
} // end bindSidePanelEvents

function getSideMemoryById(id) {
    const data = getOpenVaultData();
    return data?.[MEMORIES_KEY]?.find((m) => m.id === id) || null;
}

function findMergeTarget(inputText, nodes) {
    if (!inputText) return null;
    const clean = inputText
        .toLowerCase()
        .trim()
        .replace(/\s*\[[^\]]+\]$/, '')
        .trim();
    for (const [key, node] of Object.entries(nodes)) {
        if ((node.name || '').toLowerCase() === clean) return key;
        if ((node.aliases || []).some((a) => a.toLowerCase() === clean)) return key;
    }
    return null;
}

// =============================================================================
// Export/Import Handlers (Feature #6)
// =============================================================================

async function handleCopyMemoryDatabase() {
    try {
        const payload = buildUserExportPayload();
        if (!payload) {
            showToast('warning', 'No data to copy');
            return;
        }
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        showToast('success', 'Memory database copied to clipboard');
    } catch (err) {
        console.error('[OpenVault] Copy error:', err);
        showToast('error', `Copy failed: ${err.message}`);
    }
}

async function handleClearMemoryDatabase() {
    const data = getOpenVaultData();
    const count = data?.[MEMORIES_KEY]?.length || 0;

    if (!count) {
        showToast('info', 'No memories to clear');
        return;
    }

    if (!confirm(`Delete ALL ${count} memories? This cannot be undone. Consider exporting first.`)) {
        return;
    }

    try {
        const memories = [...(data[MEMORIES_KEY] || [])];
        const { applySyncChanges } = await import('../extraction/extract.js');

        for (const memory of memories) {
            const result = await deleteMemoryAction(memory.id);
            if (result.success && result.stChanges) {
                await applySyncChanges(result.stChanges);
            }
        }

        renderSideMemories();
        renderExportImportPanel('#openvault_export_import_content');
        showToast('success', `Cleared ${memories.length} memories`);
    } catch (err) {
        console.error('[OpenVault] Clear error:', err);
        showToast('error', `Clear failed: ${err.message}`);
    }
}

// =============================================================================
// Open / Close / Toggle
// =============================================================================

export function openSidePanel() {
    const $panel = $('#openvault_side_panel');
    const topBar = document.getElementById('top-settings-holder') || document.getElementById('top-bar');
    if (topBar) {
        $panel.css('top', topBar.offsetHeight + 'px');
    }
    $panel.addClass('open');
    $('#openvault_side_panel_toggle').addClass('active');
    refreshSidePanel();
}

export function closeSidePanel() {
    $('#openvault_side_panel').removeClass('open');
    $('#openvault_side_panel_toggle').removeClass('active');
}

export function toggleSidePanel() {
    if ($('#openvault_side_panel').hasClass('open')) {
        closeSidePanel();
    } else {
        openSidePanel();
    }
}

export function isSidePanelOpen() {
    return $('#openvault_side_panel').hasClass('open');
}

// =============================================================================
// Sidebar-specific memory card (buttons beside date, compact layout)
// =============================================================================

function buildSideCharacterTags(characters) {
    if (!characters || characters.length === 0) return '';
    const tags = characters.map((c) => `<span class="openvault-character-tag">${escapeHtml(c)}</span>`).join('');
    return `<div class="openvault-memory-characters" style="margin-top: 4px;">${tags}</div>`;
}

// Session-level LLM contradiction call counter (reset on page load)
let _sessionLLMCallCount = 0;

/**
 * Increment the session LLM call counter and update the UI element.
 * Called from settings.js after manual or batch contradiction scans.
 * @param {number} count - Number of LLM calls to add (default 1)
 */
export function incrementSessionLLMCallCount(count = 1) {
    _sessionLLMCallCount += count;
    const $el = $('#openvault_side_contradiction_session_calls');
    if ($el.length) $el.text(_sessionLLMCallCount);
}

function renderSideMemoryItem(memory) {
    const id = escapeHtml(memory.id);
    const date = formatMemoryDate(memory.created_at);
    const stars = formatMemoryImportance(memory.importance || 3);
    const isReflection = memory.type === 'reflection';
    const isArchived = !!memory.archived;
    const isMerged = !!(memory.merge_sources && memory.merge_sources.length);

    // Reflections don't have time anchors — show a reflection badge in that slot instead
    let leadBadge = '';
    if (isReflection) {
        leadBadge =
            '<span class="openvault-memory-card-badge reflection"><i class="fa-solid fa-lightbulb"></i> Reflection</span>';
    } else if (memory.temporal_anchor) {
        leadBadge = `<span class="openvault-side-mem-date" style="color: var(--SmartThemeQuoteColor);"><i class="fa-solid fa-clock"></i> ${escapeHtml(memory.temporal_anchor)}</span>`;
    }

    // Status badges (archived / merged)
    const statusBadges = [];
    if (isArchived) {
        statusBadges.push('<span class="openvault-archived-badge"><i class="fa-solid fa-box-archive"></i> Archived</span>');
    }
    if (isMerged) {
        statusBadges.push('<span class="openvault-merged-badge" style="color: #6bb5ff;"><i class="fa-solid fa-link"></i> Merged</span>');
    }

    const charTags = buildSideCharacterTags(memory.characters_involved);

    // Collapsible merge details
    let mergeDetails = '';
    if (isMerged) {
        const sources = (memory.merge_sources || []).map((s) => escapeHtml(s)).join(', ');
        const ts = memory.merge_timestamp ? new Date(memory.merge_timestamp).toLocaleString() : 'unknown';
        mergeDetails = `
            <details class="openvault-merge-details" style="margin-top: 4px;">
                <summary style="cursor: pointer; font-size: 0.8em; color: var(--SmartThemeQuoteColor);">
                    <i class="fa-solid fa-code-merge"></i> Merge info
                </summary>
                <div style="padding: 4px 0; font-size: 0.78em; line-height: 1.4;">
                    <div><strong>Sources:</strong> ${sources}</div>
                    <div><strong>Merged at:</strong> ${escapeHtml(ts)}</div>
                </div>
            </details>
        `;
    }

    const archivedClass = isArchived ? ' openvault-card-archived' : '';

    return `
        <div class="openvault-memory-card openvault-side-mem${archivedClass}" data-id="${id}">
            <div class="openvault-side-mem-header">
                <div class="openvault-side-mem-meta">
                    ${leadBadge}
                    <span class="openvault-side-mem-date">${escapeHtml(date)}</span>
                    <span class="openvault-memory-card-badge importance">${stars}</span>
                    ${statusBadges.join(' ')}
                </div>
                <div class="openvault-side-mem-actions">
                    <button class="openvault-entity-action-btn openvault-edit-memory" data-id="${id}" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="openvault-entity-action-btn openvault-delete-memory" data-id="${id}" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="openvault-memory-card-summary">${escapeHtml(memory.summary || 'No summary')}</div>
            ${charTags}
            ${mergeDetails}
        </div>
    `;
}

// =============================================================================
// Sidebar-specific community templates (edit/delete buttons + edit form)
// =============================================================================

function renderSideCommunityCard(id, community) {
    const memberCount = community.nodeKeys?.length || 0;
    const findings = (community.findings || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    const members = (community.nodeKeys || []).map((k) => escapeHtml(k)).join(', ');

    return `
        <div class="openvault-community-item openvault-side-community-card" data-id="${escapeHtml(id)}">
            <div class="openvault-community-card-header">
                <span class="openvault-community-title">${escapeHtml(community.title || id)}</span>
                <span class="openvault-community-badge">${memberCount} entities</span>
                <div class="openvault-community-actions">
                    <button class="openvault-entity-action-btn openvault-edit-community" data-id="${escapeHtml(id)}" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="openvault-entity-action-btn openvault-delete-community" data-id="${escapeHtml(id)}" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="openvault-community-card-body">
                <p class="openvault-community-summary">${escapeHtml(community.summary || 'No summary')}</p>
                ${findings ? `<ul class="openvault-community-findings">${findings}</ul>` : ''}
                <small class="openvault-community-members">Members: ${members}</small>
            </div>
        </div>
    `;
}

function renderSideCommunityEdit(id, community) {
    return `
        <div class="openvault-community-editing" data-id="${escapeHtml(id)}">
            <div class="openvault-entity-edit-row">
                <label>Title</label>
                <input type="text" class="openvault-community-edit-title" value="${escapeHtml(community.title || '')}">
            </div>
            <div class="openvault-entity-edit-row">
                <label>Summary</label>
                <textarea class="openvault-community-edit-summary" rows="4">${escapeHtml(community.summary || '')}</textarea>
            </div>
            <div class="openvault-entity-edit-actions">
                <button class="cancel openvault-cancel-community-edit" data-id="${escapeHtml(id)}">Cancel</button>
                <button class="save openvault-save-community" data-id="${escapeHtml(id)}">Save</button>
            </div>
        </div>
    `;
}

// =============================================================================
// Rendering
// =============================================================================

export function refreshSidePanel() {
    if (!isSidePanelOpen()) return;

    renderSideMemories();
    renderSideCommunities();
    renderSideEntities();
    renderSideCharacters();

    // Only render active tab content
    const activeTab = $('.openvault-side-tab-content.active').data('side-tab-content');
    if (activeTab === 'graph') {
        renderGraphViz();
    } else if (activeTab === 'timeline') {
        renderTimelinePanel('#openvault_timeline_content');
    } else if (activeTab === 'duplicates') {
        renderDuplicatePanel(document.getElementById('openvault_duplicates_content'));
    }
}

function renderSideMemories() {
    const $container = $('#openvault_side_memories');
    const data = getOpenVaultData();

    if (!data) {
        $container.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        return;
    }

    const memories = (data[MEMORIES_KEY] || []).filter((m) => !m.archived);

    if (memories.length === 0) {
        $container.html('<p class="openvault-side-placeholder">No memories yet</p>');
        return;
    }

    // Sort oldest first so latest is at the bottom (natural scroll)
    const sorted = [...memories].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const html = sorted.map(renderSideMemoryItem).join('');
    $container.html(html);

    // Auto-scroll to bottom (latest memories)
    $container.scrollTop($container[0].scrollHeight);
}

function renderSideCommunities() {
    const $container = $('#openvault_side_communities');
    const data = getOpenVaultData();

    if (!data) {
        $container.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        return;
    }

    const communities = data?.communities || {};
    const ids = Object.keys(communities);

    if (ids.length === 0) {
        $container.html('<p class="openvault-side-placeholder">No communities detected yet</p>');
        return;
    }

    const html = ids.map((id) => renderSideCommunityCard(id, communities[id])).join('');
    $container.html(html);
}

// =============================================================================
// Manage Tab (sort, filter, bulk actions)
// =============================================================================

/** @type {Set<string>} Selected memory IDs in the manage tab */
const _manageSelected = new Set();
let _manageSearchTimeout = null;

/**
 * Render the Manage tab memory list with filters and bulk actions
 */
function renderSideManage() {
    const $list = $('#openvault_side_manage_list');
    const data = getOpenVaultData();

    if (!data) {
        $list.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        return;
    }

    const allMemories = data[MEMORIES_KEY] || [];
    const typeFilter = $('#openvault_side_manage_type').val() || '';
    const showArchived = $('#openvault_side_manage_archived').is(':checked');
    const sortOrder = $('#openvault_side_manage_sort').val() || 'date';
    const searchQuery = ($('#openvault_side_manage_search').val() || '').toLowerCase().trim();

    let filtered = filterMemories(allMemories, typeFilter, '', { showArchived: true });

    // Apply archived filter manually since we want to control it via the toggle
    if (!showArchived) {
        filtered = filtered.filter((m) => !m.archived);
    }

    // Search filter
    if (searchQuery) {
        filtered = filtered.filter((m) => {
            const s = (m.summary || '').toLowerCase();
            const c = (m.characters_involved || []).join(' ').toLowerCase();
            return s.includes(searchQuery) || c.includes(searchQuery);
        });
    }

    filtered = sortMemories(filtered, sortOrder);

    if (filtered.length === 0) {
        $list.html('<p class="openvault-side-placeholder">No memories match</p>');
        return;
    }

    const html = filtered
        .map((m) => {
            const id = escapeHtml(m.id);
            const checked = _manageSelected.has(m.id) ? 'checked' : '';
            const archivedClass = m.archived ? ' openvault-card-archived' : '';
            const stars = formatMemoryImportance(m.importance || 3);
            const date = formatMemoryDate(m.created_at);
            const badge = m.archived
                ? '<span class="openvault-archived-badge"><i class="fa-solid fa-box-archive"></i> Archived</span>'
                : '';
            const typeLabel =
                m.type === 'reflection'
                    ? '<span class="openvault-memory-card-badge reflection"><i class="fa-solid fa-lightbulb"></i></span>'
                    : '';

            return `
            <div class="openvault-memory-card openvault-side-mem${archivedClass}" data-id="${id}">
                <div class="openvault-manage-card-header">
                    <label class="openvault-manage-select-label">
                        <input type="checkbox" class="openvault-manage-select" data-id="${id}" ${checked} />
                    </label>
                    <div class="openvault-side-mem-meta">
                        ${typeLabel}
                        <span class="openvault-memory-card-badge importance">${stars}</span>
                        <span class="openvault-side-mem-date">${escapeHtml(date)}</span>
                        ${badge}
                    </div>
                </div>
                <div class="openvault-memory-card-summary">${escapeHtml(m.summary || 'No summary')}</div>
            </div>
        `;
        })
        .join('');

    $list.html(html);
    updateManageBulkBar();
}

function updateManageBulkBar() {
    const count = _manageSelected.size;
    if (count > 0) {
        $('#openvault_side_manage_bulk').show();
        $('#openvault_side_manage_count').text(count);
    } else {
        $('#openvault_side_manage_bulk').hide();
    }
}

function initManageTabEvents($panel) {
    // Re-render on filter/sort change
    const manageInputs =
        '#openvault_side_manage_search, #openvault_side_manage_type, #openvault_side_manage_sort, #openvault_side_manage_archived';
    $panel.on('input change', manageInputs, () => {
        clearTimeout(_manageSearchTimeout);
        _manageSearchTimeout = setTimeout(renderSideManage, 200);
    });

    // Individual checkbox
    $panel.on('change', '.openvault-manage-select', function () {
        const id = String($(this).data('id'));
        if (this.checked) _manageSelected.add(id);
        else _manageSelected.delete(id);
        updateManageBulkBar();
    });

    // Select all
    $panel.on('change', '#openvault_side_manage_select_all', function () {
        const checked = this.checked;
        $panel.find('.openvault-manage-select').prop('checked', checked);
        $panel.find('.openvault-manage-select').each(function () {
            const id = String($(this).data('id'));
            if (checked) _manageSelected.add(id);
            else _manageSelected.delete(id);
        });
        updateManageBulkBar();
    });

    // Bulk archive
    $panel.on('click', '#openvault_side_manage_archive_btn', async () => {
        const ids = [..._manageSelected];
        if (!ids.length) return;
        if (!confirm(`Archive ${ids.length} memory(ies)?`)) return;
        const result = await archiveMemories(ids);
        if (result.count > 0) {
            _manageSelected.clear();
            renderSideManage();
            refreshStats();
            populateFilter();
            showToast('success', `Archived ${result.count} memories`);
        }
    });

    // Bulk unarchive
    $panel.on('click', '#openvault_side_manage_unarchive_btn', async () => {
        const ids = [..._manageSelected];
        if (!ids.length) return;
        const result = await unarchiveMemories(ids);
        if (result.count > 0) {
            _manageSelected.clear();
            renderSideManage();
            refreshStats();
            populateFilter();
            showToast('success', `Unarchived ${result.count} memories`);
        }
    });

    // Bulk delete
    $panel.on('click', '#openvault_side_manage_delete_btn', async () => {
        const ids = [..._manageSelected];
        if (!ids.length) return;
        if (!confirm(`Permanently delete ${ids.length} memory(ies)? This cannot be undone.`)) return;
        const result = await deleteMemoriesBulk(ids);
        if (result.success) {
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            _manageSelected.clear();
            renderSideManage();
            refreshStats();
            populateFilter();
            showToast('success', `Deleted ${result.count} memories`);
        }
    });

    // Archive all memories matching current filters
    $panel.on('click', '#openvault_side_manage_archive_all_btn', async () => {
        const data = getOpenVaultData();
        if (!data) return;

        const allMemories = data[MEMORIES_KEY] || [];
        const typeFilter = $('#openvault_side_manage_type').val() || '';
        const showArchived = $('#openvault_side_manage_archived').is(':checked');
        const searchQuery = ($('#openvault_side_manage_search').val() || '').toLowerCase().trim();

        let filtered = filterMemories(allMemories, typeFilter, '', { showArchived: true });
        if (!showArchived) {
            filtered = filtered.filter((m) => !m.archived);
        }
        if (searchQuery) {
            filtered = filtered.filter((m) => {
                const s = (m.summary || '').toLowerCase();
                const c = (m.characters_involved || []).join(' ').toLowerCase();
                return s.includes(searchQuery) || c.includes(searchQuery);
            });
        }

        // Only archive non-archived memories
        const toArchive = filtered.filter((m) => !m.archived);
        if (toArchive.length === 0) {
            showToast('info', 'No unarchived memories match the current filters.');
            return;
        }

        if (!confirm(`Archive ${toArchive.length} memory(ies) matching current filters?`)) return;

        const ids = toArchive.map((m) => m.id);
        const result = await archiveMemories(ids);
        if (result.count > 0) {
            if (result.stChanges) {
                const { applySyncChanges } = await import('../extraction/extract.js');
                await applySyncChanges(result.stChanges);
            }
            _manageSelected.clear();
            renderSideManage();
            refreshStats();
            populateFilter();
            showToast('success', `Archived ${result.count} memories matching filters`);
        }
    });
}

function renderSideEntities() {
    const $container = $('#openvault_side_entities');
    const data = getOpenVaultData();

    if (!data) {
        $container.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        return;
    }

    const graph = data?.graph || {};
    const typeFilter = $('#openvault_side_entity_type').val() || '';
    const searchQuery = ($('#openvault_side_entity_search').val() || '').toLowerCase().trim();
    const searchScope = $('#openvault_side_entity_search_scope').val() || 'all';

    const filtered = filterEntities(graph, searchQuery, typeFilter, searchScope);

    if (filtered.length === 0) {
        const msg = searchQuery || typeFilter ? 'No entities match your filters' : 'No entities extracted yet';
        $container.html(`<p class="openvault-side-placeholder">${escapeHtml(msg)}</p>`);
        return;
    }

    const html = filtered.map(([key, entity]) => renderEntityCard(entity, key)).join('');
    $container.html(html);
}

function renderSideCharacters() {
    const $container = $('#openvault_side_characters');
    const data = getOpenVaultData();

    if (!data) {
        $container.html('<p class="openvault-side-placeholder">No chat loaded</p>');
        return;
    }

    const characters = data[CHARACTERS_KEY] || {};
    const charNames = Object.keys(characters);

    if (charNames.length === 0) {
        $container.html('<p class="openvault-side-placeholder">No character data yet</p>');
        return;
    }

    const html = charNames
        .sort()
        .map((name) => renderCharacterState(buildCharacterStateData(name, characters[name])))
        .join('');

    $container.html(html);
}
