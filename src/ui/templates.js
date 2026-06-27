/**
 * UI Templates
 *
 * Pure template functions for rendering UI elements.
 * Zero side effects, easily testable.
 */

import { ENTITY_TYPES } from '../constants.js';
import { isEmbeddingsEnabled } from '../embeddings.js';
import { escapeHtml } from '../utils/dom.js';
import { hasEmbedding } from '../utils/embedding-codec.js';
import { formatMemoryDate, formatMemoryImportance, formatWitnesses, getTransientDecayInfo } from './helpers.js';

// CSS class constants
const CLASSES = {
    MEMORY_CARD: 'openvault-memory-card',
    PLACEHOLDER: 'openvault-placeholder',
    CHARACTER_TAG: 'openvault-character-tag',
    MEMORY_CHARACTERS: 'openvault-memory-characters',
};

// =============================================================================
// Memory Card Templates
// =============================================================================

/**
 * Build badge HTML for a memory card
 */
function buildBadges(memory) {
    const badges = [];
    const importance = memory.importance || 3;
    const stars = formatMemoryImportance(importance);
    const witnessText = formatWitnesses(memory.witnesses);
    const location = memory.location || '';
    const needsEmbed = !hasEmbedding(memory) && isEmbeddingsEnabled();

    badges.push(`<span class="openvault-memory-card-badge importance">${stars}</span>`);

    if (memory.archived) {
        badges.push(
            `<span class="openvault-memory-card-badge archived"><i class="fa-solid fa-box-archive"></i> Archived</span>`
        );
    }
    if (needsEmbed) {
        badges.push(
            `<span class="openvault-memory-card-badge pending-embed" title="Embedding pending"><i class="fa-solid fa-rotate-right"></i></span>`
        );
    }
    if (memory.type === 'reflection') {
        badges.push(
            `<span class="openvault-memory-card-badge reflection"><i class="fa-solid fa-lightbulb"></i> Reflection</span>`
        );
        if (memory.source_ids?.length > 0) {
            badges.push(
                `<span class="openvault-memory-card-badge evidence"><i class="fa-solid fa-link"></i> ${memory.source_ids.length} evidence</span>`
            );
        }
    }
    if (witnessText) {
        badges.push(
            `<span class="openvault-memory-card-badge witness"><i class="fa-solid fa-eye"></i> ${escapeHtml(witnessText)}</span>`
        );
    }
    if (location) {
        badges.push(
            `<span class="openvault-memory-card-badge location"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(location)}</span>`
        );
    }
    if (memory.is_transient) {
        const decayInfo = getTransientDecayInfo(memory);
        badges.push(
            `<span class="openvault-memory-card-badge transient" title="Half-life: ${decayInfo.halfLife.toFixed(1)} extractions"><i class="fa-solid fa-wind"></i> ${decayInfo.label || 'Transient'}</span>`
        );
    }

    return badges.join('');
}

/**
 * Build character tags HTML
 */
function buildCharacterTags(characters) {
    if (!characters || characters.length === 0) return '';

    const tags = characters.map((c) => `<span class="${CLASSES.CHARACTER_TAG}">${escapeHtml(c)}</span>`).join('');

    return `<div class="${CLASSES.MEMORY_CHARACTERS}" style="margin-top: 8px;">${tags}</div>`;
}

/**
 * Build card header HTML
 */
function buildCardHeader(memory) {
    const date = formatMemoryDate(memory.created_at);
    const anchorHtml = memory.temporal_anchor
        ? `<span class="openvault-memory-card-date" style="color: var(--SmartThemeQuoteColor);"><i class="fa-solid fa-clock"></i> ${escapeHtml(memory.temporal_anchor)}</span>`
        : '';

    return `
        <div class="openvault-memory-card-header">
            <div class="openvault-memory-card-meta">
                ${anchorHtml}
                <span class="openvault-memory-card-date">${escapeHtml(date)}</span>
            </div>
        </div>
    `;
}

/**
 * Build card footer HTML
 */
function buildCardFooter(memory, badges) {
    const id = escapeHtml(memory.id);
    return `
        <div class="openvault-memory-card-footer">
            <div class="openvault-memory-card-badges">
                ${badges}
            </div>
            <div>
                <button class="menu_button openvault-edit-memory" data-id="${id}" title="Edit memory">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="menu_button openvault-delete-memory" data-id="${id}" title="Delete memory">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

/**
 * Render a single memory item as a card
 */
export function renderMemoryItem(memory) {
    const id = escapeHtml(memory.id);
    const badges = buildBadges(memory);
    const characterTags = buildCharacterTags(memory.characters_involved);

    return `
        <div class="${CLASSES.MEMORY_CARD}" data-id="${id}">
            <div class="openvault-memory-card-select">
                <input type="checkbox" class="openvault-memory-select" data-id="${id}" title="Select for bulk action" />
            </div>
            ${buildCardHeader(memory)}
            <div class="openvault-memory-card-summary">${escapeHtml(memory.summary || 'No summary')}</div>
            ${buildCardFooter(memory, badges)}
            ${characterTags}
        </div>
    `;
}

/**
 * Build importance select options
 */
function buildImportanceOptions(current) {
    return [1, 2, 3, 4, 5].map((i) => `<option value="${i}"${i === current ? ' selected' : ''}>${i}</option>`).join('');
}

/**
 * Build character tags input for editing
 */
function buildWitnessEditField(memory) {
    const witnesses = memory.witnesses || [];
    const witnessStr = witnesses.join(', ');
    return `
        <div class="openvault-edit-row">
            <label>Witnesses</label>
            <input type="text" class="text_pole" data-field="witnesses" value="${escapeHtml(witnessStr)}" placeholder="e.g. Alex, Derek, Sarah">
            <small>Comma-separated list of witness names</small>
        </div>
    `;
}

/**
 * Build edit form fields
 */
function buildEditFields(memory) {
    const importance = memory.importance || 3;

    return `
        <div class="openvault-edit-row">
            <label>
                Importance
                <select data-field="importance">${buildImportanceOptions(importance)}</select>
            </label>
        </div>
        <div class="openvault-edit-row">
            <label>Time Anchor</label>
            <input type="text" class="text_pole" data-field="temporal_anchor" value="${escapeHtml(memory.temporal_anchor || '')}" placeholder="e.g. Friday 3:00 PM">
        </div>
        ${buildWitnessEditField(memory)}
        <div class="openvault-edit-row">
            <label class="checkbox_label">
                <input type="checkbox" data-field="is_transient" ${memory.is_transient ? 'checked' : ''}>
                <span>Transient (Fades fast)</span>
            </label>
        </div>
    `;
}

/**
 * Build edit action buttons
 */
function buildEditActions(id) {
    const escapedId = escapeHtml(id);
    return `
        <div class="openvault-edit-actions">
            <button class="menu_button openvault-cancel-edit" data-id="${escapedId}">
                <i class="fa-solid fa-times"></i> Cancel
            </button>
            <button class="menu_button openvault-save-edit" data-id="${escapedId}">
                <i class="fa-solid fa-check"></i> Save
            </button>
        </div>
    `;
}

/**
 * Render edit mode template for a memory
 */
export function renderMemoryEdit(memory) {
    const id = escapeHtml(memory.id);

    return `
        <div class="${CLASSES.MEMORY_CARD}" data-id="${id}">
            <div class="openvault-edit-form">
                <textarea class="openvault-edit-textarea" data-field="summary">${escapeHtml(memory.summary || '')}</textarea>
                ${buildEditFields(memory)}
                ${buildEditActions(memory.id)}
            </div>
        </div>
    `;
}

// =============================================================================
// Character State Templates
// =============================================================================

/**
 * Render a single character state as HTML
 */
export function renderCharacterState(charData) {
    return `
        <div class="openvault-character-item">
            <div class="openvault-character-header">
                <div class="openvault-character-name">${escapeHtml(charData.name)}</div>
                <button class="openvault-character-delete" data-character="${escapeHtml(charData.name)}" title="Remove this character from the vault">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="openvault-emotion">
                <span class="openvault-emotion-label">${escapeHtml(charData.emotion)}${charData.emotionSource || ''}</span>
                <div class="openvault-emotion-bar">
                    <div class="openvault-emotion-fill" style="width: ${charData.intensityPercent}%"></div>
                </div>
            </div>
            <div class="openvault-memory-witnesses">Known events: ${charData.knownCount}</div>
        </div>
    `;
}

// =============================================================================
// Character Dossier Template
// =============================================================================

/**
 * Render a read-only per-character dossier body: progress toward the next
 * reflection, the character's insights grouped by synthesis level (each with an
 * evidence drill-down), and their relationships from the knowledge graph.
 *
 * Intended to nest below a compact character card (`renderCharacterState`) in a
 * click-to-expand accordion. The card already renders identity + current emotion,
 * so this renders only the dossier's distinct sections and intentionally does not
 * repeat the name/state header.
 *
 * Pure string template; all interpolated content is HTML-escaped.
 *
 * @param {Object} dossier - Output of `buildCharacterDossier()`
 * @returns {string} HTML
 */
export function renderCharacterDossier(dossier) {
    const reflectionsByLevel = dossier?.reflectionsByLevel || [];
    const relationships = dossier?.relationships || [];
    const progress = dossier?.progress || { importanceSum: 0, threshold: 40, percent: 0, ready: false };

    return `
        <div class="openvault-character-dossier">
            ${renderDossierActions()}
            ${renderDossierProgress(progress)}
            <div class="openvault-dossier-section">
                <div class="openvault-dossier-section-title"><i class="fa-solid fa-lightbulb"></i> Insights</div>
                ${renderDossierReflections(reflectionsByLevel)}
            </div>
            <div class="openvault-dossier-section">
                <div class="openvault-dossier-section-title"><i class="fa-solid fa-diagram-project"></i> Relationships</div>
                ${renderDossierRelationships(relationships)}
            </div>
        </div>
    `;
}

/** Render the export actions (copy text / download lorebook). Read-only export only. */
function renderDossierActions() {
    return `
        <div class="openvault-dossier-actions">
            <button class="openvault-btn openvault-export-import-btn openvault-dossier-action-btn" data-action="dossier-copy-text" title="Copy this dossier as text">
                <i class="fa-solid fa-copy"></i> Copy as text
            </button>
            <button class="openvault-btn openvault-export-import-btn openvault-dossier-action-btn" data-action="dossier-export-lorebook" title="Download as a SillyTavern lorebook entry">
                <i class="fa-solid fa-book-bookmark"></i> Download lorebook
            </button>
        </div>
    `;
}

/** Render the "next insight" progress meter (importance sum vs threshold). */
function renderDossierProgress(progress) {
    const readyBadge = progress.ready
        ? '<span class="openvault-dossier-progress-ready" title="Enough accumulated importance to synthesize a new insight"><i class="fa-solid fa-lightbulb"></i> Ready</span>'
        : '';
    return `
        <div class="openvault-dossier-progress">
            <div class="openvault-dossier-progress-label">Next insight: ${progress.importanceSum || 0}/${progress.threshold} ${readyBadge}</div>
            <div class="openvault-dossier-progress-bar">
                <div class="openvault-dossier-progress-fill" style="width: ${progress.percent || 0}%"></div>
            </div>
        </div>
    `;
}

/** Render reflections grouped by synthesis level (descending). */
function renderDossierReflections(reflectionsByLevel) {
    if (!reflectionsByLevel || reflectionsByLevel.length === 0) {
        return '<p class="openvault-placeholder">No insights yet</p>';
    }
    const groups = reflectionsByLevel
        .map((group) => {
            const label = group.level >= 2 ? 'Headline traits' : 'Supporting specifics';
            const cards = group.reflections.map(renderDossierReflectionCard).join('');
            return `
                <div class="openvault-dossier-level-group" data-level="${group.level}">
                    <div class="openvault-dossier-level-label"><span class="openvault-dossier-level-badge">L${group.level}</span> ${escapeHtml(label)}</div>
                    ${cards}
                </div>
            `;
        })
        .join('');
    return `<div class="openvault-dossier-reflections">${groups}</div>`;
}

/** Render one reflection card with its collapsible evidence chain. */
function renderDossierReflectionCard(reflection) {
    const stars = '★'.repeat(reflection.importance || 3);
    const summary = escapeHtml(reflection.summary || 'No summary');
    return `
        <div class="openvault-dossier-reflection">
            <div class="openvault-dossier-reflection-meta">
                <span class="openvault-memory-card-badge importance">${stars}</span>
                <span class="openvault-dossier-level-badge">L${reflection.level || 1}</span>
            </div>
            <div class="openvault-dossier-reflection-summary">${summary}</div>
            ${renderDossierEvidence(reflection.evidence)}
        </div>
    `;
}

/** Render the evidence drill-down for a reflection, flagging deleted sources. */
function renderDossierEvidence(evidence) {
    if (!Array.isArray(evidence) || evidence.length === 0) return '';
    const items = evidence
        .map((e) => {
            if (e.missing) {
                return `<li class="openvault-dossier-evidence-item missing"><i class="fa-solid fa-circle-xmark"></i> <em>Deleted memory (${escapeHtml(e.id)})</em></li>`;
            }
            const evStars = '★'.repeat(e.importance || 3);
            const levelTag = e.level ? ` <small>[L${e.level}]</small>` : '';
            const typeTag = e.type === 'reflection' ? ' <small>(reflection)</small>' : '';
            return `<li class="openvault-dossier-evidence-item"><span class="openvault-memory-card-badge importance">${evStars}</span>${levelTag}${typeTag} ${escapeHtml(e.summary || '')}</li>`;
        })
        .join('');
    return `
        <details class="openvault-dossier-evidence">
            <summary><i class="fa-solid fa-link"></i> Evidence (${evidence.length})</summary>
            <ul class="openvault-dossier-evidence-list">${items}</ul>
        </details>
    `;
}

/** Render the relationships list. Order (weight desc) is determined by the dossier. */
function renderDossierRelationships(relationships) {
    if (!relationships || relationships.length === 0) {
        return '<p class="openvault-placeholder">No relationships recorded</p>';
    }
    const items = relationships
        .map((rel) => {
            const weight =
                rel.weight > 0 ? ` <small class="openvault-dossier-relationship-weight">(w${rel.weight})</small>` : '';
            return `<li class="openvault-dossier-relationship"><span class="openvault-dossier-relationship-name">${escapeHtml(rel.name)}</span> — ${escapeHtml(rel.description || 'related')}${weight}</li>`;
        })
        .join('');
    return `<ul class="openvault-dossier-relationships">${items}</ul>`;
}

/**
 * Render reflection progress counters for all characters.
 * @param {Object|null} reflectionState - charName → { importance_sum }
 * @param {number} threshold - Reflection threshold
 * @returns {string} HTML
 */
export function renderReflectionProgress(reflectionState, threshold) {
    if (!reflectionState || Object.keys(reflectionState).length === 0) {
        return '<p class="openvault-placeholder">No reflection data yet</p>';
    }

    const items = Object.entries(reflectionState)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, state]) => {
            const sum = state.importance_sum || 0;
            return `<span class="openvault-reflection-counter">${escapeHtml(name)}: ${sum}/${threshold}</span>`;
        })
        .join(' \u00b7 ');

    return `<div class="openvault-reflection-counters">${items}</div>`;
}

/**
 * Render a single community as an accordion item.
 * @param {string} id - Community ID (e.g., "C0")
 * @param {Object} community - { title, summary, findings, nodeKeys }
 * @returns {string} HTML
 */
export function renderCommunityAccordion(id, community) {
    const memberCount = community.nodeKeys?.length || 0;
    const findings = (community.findings || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    const members = (community.nodeKeys || []).map((k) => escapeHtml(k)).join(', ');

    return `
        <details class="openvault-community-item">
            <summary>
                <span class="openvault-community-title">${escapeHtml(community.title || id)}</span>
                <span class="openvault-community-badge">${memberCount} entities</span>
            </summary>
            <div class="openvault-community-content">
                <p>${escapeHtml(community.summary || 'No summary')}</p>
                ${findings ? `<ul class="openvault-community-findings">${findings}</ul>` : ''}
                <small class="openvault-community-members">Members: ${members}</small>
            </div>
        </details>
    `;
}

/**
 * Render an entity card in view mode
 * @param {Object} entity - Entity node with name, type, description, aliases
 * @param {string} key - Normalized entity key
 * @returns {string} HTML string
 */
export function renderEntityCard(entity, key) {
    const typeLabel = entity.type.charAt(0) + entity.type.slice(1).toLowerCase();
    const aliasText = entity.aliases?.length > 0 ? entity.aliases.join(', ') : '';
    const pendingBadge = !hasEmbedding(entity)
        ? '<span class="openvault-pending-embed"><span class="icon">↻</span> pending</span>'
        : '';

    return `
    <div class="openvault-entity-card" data-key="${escapeHtml(key)}">
      <div class="openvault-entity-header">
        <span class="openvault-entity-name">${escapeHtml(entity.name)}</span>
        <div class="openvault-entity-badges">
          <span class="openvault-entity-type-badge ${entity.type.toLowerCase()}">
            ${typeLabel}
          </span>
          ${pendingBadge}
        </div>
        <div class="openvault-entity-actions">
          <button class="openvault-entity-action-btn openvault-edit-entity" data-key="${escapeHtml(key)}" title="Edit">
            ✏️
          </button>
          <button class="openvault-entity-action-btn openvault-merge-entity" data-key="${escapeHtml(key)}" title="Merge into another entity">
            <i class="fa-solid fa-code-merge"></i>
          </button>
          <button class="openvault-entity-action-btn openvault-delete-entity" data-key="${escapeHtml(key)}" title="Delete">
            🗑️
          </button>
        </div>
      </div>
      ${aliasText ? `<div class="openvault-entity-aliases">${escapeHtml(aliasText)}</div>` : ''}
      <div class="openvault-entity-description">${escapeHtml(entity.description || '')}</div>
      <small class="openvault-entity-mentions">${entity.mentions || 0} mentions</small>
    </div>
  `;
}

/**
 * Render an entity card in edit mode
 * @param {Object} entity - Entity node with name, type, description, aliases
 * @param {string} key - Normalized entity key
 * @returns {string} HTML string
 */
export function renderEntityEdit(entity, key) {
    const aliasChips = (entity.aliases || [])
        .map(
            (alias) => `
      <span class="openvault-alias-chip">
        ${escapeHtml(alias)}
        <span class="remove openvault-remove-alias" data-key="${escapeHtml(key)}" data-alias="${escapeHtml(alias)}">×</span>
      </span>
    `
        )
        .join('');

    const typeOptions = Object.entries(ENTITY_TYPES)
        .map(
            ([type]) => `
    <option value="${type}" ${entity.type === type ? 'selected' : ''}>
      ${type.charAt(0) + type.slice(1).toLowerCase()}
    </option>
  `
        )
        .join('');

    return `
    <div class="openvault-entity-edit" data-key="${escapeHtml(key)}">
      <div class="openvault-entity-edit-row">
        <label>Name</label>
        <input type="text" class="openvault-edit-name" value="${escapeHtml(entity.name)}" data-key="${escapeHtml(key)}">
      </div>
      <div class="openvault-entity-edit-row">
        <label>Type</label>
        <select class="openvault-edit-type" data-key="${escapeHtml(key)}">
          ${typeOptions}
        </select>
      </div>
      <div class="openvault-entity-edit-row">
        <label>Description</label>
        <textarea class="openvault-edit-description" data-key="${escapeHtml(key)}" rows="3">${escapeHtml(entity.description || '')}</textarea>
      </div>
      <div class="openvault-entity-edit-row">
        <label>Aliases</label>
        <div class="openvault-alias-list" data-key="${escapeHtml(key)}">
          ${aliasChips}
        </div>
        <div class="openvault-alias-input-row">
          <input type="text" class="openvault-alias-input" placeholder="e.g. The Stranger, Masked Figure..." data-key="${escapeHtml(key)}">
          <button class="openvault-add-alias" data-key="${escapeHtml(key)}">Add</button>
        </div>
      </div>
      <div class="openvault-entity-edit-actions">
        <button class="cancel openvault-cancel-entity-edit" data-key="${escapeHtml(key)}">Cancel</button>
        <button class="save openvault-save-entity-edit" data-key="${escapeHtml(key)}">Save</button>
      </div>
    </div>
  `;
}

/**
 * Render a merge picker panel using native HTML5 datalist.
 * @param {string} sourceKey - The entity being merged (will be deleted)
 * @param {Object} sourceNode - The source entity node data
 * @param {Object} graphNodes - All nodes in graph (for building options)
 * @returns {string} HTML string for the merge picker
 */
export function renderEntityMergePicker(sourceKey, sourceNode, graphNodes) {
    const sourceDisplay = escapeHtml(sourceNode.name || sourceKey);
    const datalistId = `merge-targets-${sourceKey.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Build datalist options from all nodes except source
    // Include both name and aliases as separate options for searchability
    const options = Object.entries(graphNodes)
        .filter(([key]) => key !== sourceKey)
        .flatMap(([key, node]) => {
            const displayName = escapeHtml(node.name || key);
            const typeLabel = node.type ? ` [${node.type}]` : '';
            const primaryOption = `<option value="${displayName}${typeLabel}" data-key="${escapeHtml(key)}">`;

            // Also add alias options pointing to same entity
            const aliasOptions = (node.aliases || [])
                .filter((alias) => alias !== node.name)
                .map(
                    (alias) =>
                        `<option value="${escapeHtml(alias)} [alias of ${displayName}]" data-key="${escapeHtml(key)}">`
                );

            return [primaryOption, ...aliasOptions];
        })
        .join('\n');

    return `
    <div class="openvault-entity-merge-panel" data-source-key="${escapeHtml(sourceKey)}">
      <div class="merge-header">
        <h4>Merge "${sourceDisplay}" into another entity</h4>
        <p class="merge-explanation">
          "${sourceDisplay}" will be deleted. Its relationships, aliases, and description
          will be combined into the target entity.
        </p>
      </div>

      <div class="merge-target-picker">
        <label for="merge-target-input-${sourceKey}">Target:</label>
        <input
          type="text"
          id="merge-target-input-${sourceKey}"
          class="openvault-merge-search"
          placeholder="Type to search entities..."
          autocomplete="off"
          list="${datalistId}"
        />
        <datalist id="${datalistId}">
          ${options}
        </datalist>
      </div>

      <div class="merge-actions">
        <button class="openvault-cancel-entity-merge" data-key="${escapeHtml(sourceKey)}">
          Cancel
        </button>
        <button class="openvault-confirm-entity-merge" data-source-key="${escapeHtml(sourceKey)}">
          Confirm Merge
        </button>
      </div>
    </div>
  `;
}
