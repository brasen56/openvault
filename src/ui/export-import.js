/**
 * OpenVault User-Facing Memory Export/Import
 *
 * Provides downloadable JSON export of the memory graph and import with merge/replace options.
 * Strips internal fields (embeddings, tokens, sync state) from the export payload.
 */

import { CHARACTERS_KEY, MEMORIES_KEY } from '../constants.js';
import { parseReclassificationResponse } from '../extraction/structured.js';
import { getSettings, setSetting } from '../settings.js';
import { getOpenVaultData, saveOpenVaultData } from '../store/chat-data.js';
import { showToast } from '../utils/dom.js';
import { deleteEmbedding } from '../utils/embedding-codec.js';

/** Current export schema version for forward compatibility */
const EXPORT_SCHEMA_VERSION = 1;

/** Fallback completion budget for AI Reclassify when no setting is present. */
const RECLASSIFY_DEFAULT_MAX_TOKENS = 8000;

/**
 * Fields to strip from memory objects during export.
 * These are internal runtime/embedding fields not meaningful for transfer.
 */
const MEMORY_STRIP_FIELDS = [
    'embedding',
    'embedding_b64',
    '_st_synced',
    'tokens',
    '_proxyVectorScore',
    'message_fingerprints',
];

/**
 * Fields to strip from graph node objects during export.
 */
const NODE_STRIP_FIELDS = ['embedding', 'embedding_b64', '_st_synced'];

/**
 * Fields to strip from graph edge objects during export.
 */
const EDGE_STRIP_FIELDS = ['embedding', 'embedding_b64', '_st_synced', '_descriptionTokens'];

/**
 * Fields to strip from community objects during export.
 */
const COMMUNITY_STRIP_FIELDS = ['embedding', 'embedding_b64', '_st_synced'];

/**
 * Fields to strip from character state objects during export.
 */
const CHARACTER_STRIP_FIELDS = [];

/**
 * Fields to strip from graph metadata during export.
 */
const GRAPH_META_STRIP_FIELDS = ['_mergeRedirects', '_edgesNeedingConsolidation'];

// =============================================================================
// Reclassification: Heuristic Patterns
// =============================================================================

/**
 * Regex patterns that indicate a memory is likely transient.
 * Each pattern is tested case-insensitively against the memory summary.
 * A match means the memory describes a fleeting, mundane, or purely cosmetic
 * action that shouldn't carry lasting narrative weight.
 */
const TRANSIENT_HEURISTIC_PATTERNS = [
    // Clothing / appearance choices
    /\b(chose|decided|picked|opted)\s+to\s+wear\b/i,
    /\b(wearing|wore|dressed\s+in|put\s+on)\s+(a|the|some|their)\s+(shirt|dress|jacket|coat|hat|shoes|boots|outfit|sweater|hoodie|jeans|pants|skirt|suit|tie|glasses|accessor)/i,
    /\b(changed|switched)\s+(into|out\s+of|their)\s+(clothes|outfit|attire)\b/i,
    /\bdoing\s+(their|her|his|its)\s+(hair|makeup|nails)\b/i,

    // Mundane sensory / momentary observations
    /\b(glanced|looked|peeked|stared)\s+(at|out|around|toward|towards|into)\b/i,
    /\b(noticed|spotted|caught\s+sight\s+of)\s+(a|the|some)\b/i,
    /\b(gazed|stared)\s+(at|out|into)\b.*\b(seeing|watching|observing)\b/i,

    // Transient postures / positions
    /\b(sat\s+down|stood\s+up|leaned\s+(against|on)|paced|wandered\s+(around|over|to))\b/i,
    /\b(stretched|yawned|sighed|shrugged|crossed\s+(their|her|his|its)\s+(arms|legs))\b/i,

    // Fleeting emotions / states
    /\b(felt|feeling)\s+(a\s+bit|slightly|momentarily|suddenly|briefly|a\s+little)\s+(tired|hungry|thirsty|cold|warm|bored|annoyed|distracted)\b/i,
    /\b(woke\s+up|went\s+to\s+(sleep|bed)|dozed\s+off|napped)\b(?!.*(?:nightmare|dreamt|dreamed\s+(of|about)|couldn['']t\s+sleep|insomnia))/i,

    // Consumable actions (single-instance food/drink)
    /\b(grabbed|ordered|poured|made|brewed|fixed)\s+(a|some|the|their)\s+(coffee|tea|drink|snack|sandwich|meal|breakfast|lunch|dinner)\b/i,
    /\b(ate|drank|sipped|finished|nibbled|munched)\s+(a|the|some|their)\b/i,

    // Self-care / grooming (single instance)
    /\b(brushed\s+(their|her|his|its)\s+(hair|teeth)|took\s+a\s+shower|took\s+a\s+bath|washed\s+(their|her|his|its)\s+(face|hands))\b/i,

    // Minor conversational gestures
    /\b(smiled|nodded|chuckled|laughed|grinned|winked|rolled\s+(their|her|his|its)\s+eyes)\b/i,

    // Weather / environment observations (unless dramatic)
    /\b(it\s+was\s+(a\s+bit|slightly|kind\s+of)\s+(cold|warm|hot|cool|breezy|windy|rainy|sunny|cloudy))\b/i,
    /\b(the\s+(sun|moon)\s+(was|is)\s+(shining|out|bright))\b/i,
];

/**
 * Determine if a memory summary matches heuristic transient patterns.
 * @param {string} summary - The memory summary text
 * @returns {boolean}
 */
function matchesTransientHeuristic(summary) {
    if (!summary) return false;
    for (const pattern of TRANSIENT_HEURISTIC_PATTERNS) {
        if (pattern.test(summary)) return true;
    }
    return false;
}

// =============================================================================
// Reclassification: Quick Heuristic Button
// =============================================================================

/**
 * Scan all non-transient memories and mark those matching heuristic patterns
 * as transient. Runs synchronously on existing data — no LLM calls.
 * @returns {{ marked: number, total: number }} Counts
 */
export async function heuristicReclassifyTransient() {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { marked: 0, total: 0 };
    }

    const memories = data[MEMORIES_KEY] || [];
    const { updateMemory } = await import('../store/chat-data.js');
    const { applySyncChanges } = await import('../extraction/extract.js');

    let marked = 0;
    for (const mem of memories) {
        // Skip already-transient and reflections
        if (mem.is_transient) continue;
        if (mem.type === 'reflection') continue;

        const summary = mem.summary || '';
        if (matchesTransientHeuristic(summary)) {
            const result = await updateMemory(mem.id, { is_transient: true });
            if (result.success) {
                if (result.stChanges) {
                    await applySyncChanges(result.stChanges);
                }
                marked++;
            }
        }
    }

    if (marked > 0) {
        const { refreshSidePanel } = await import('./side-panel.js');
        refreshSidePanel();
        showToast('success', `Marked ${marked} of ${memories.length} memories as transient`);
    } else {
        showToast('info', 'No new transient memories found by heuristic');
    }

    return { marked, total: memories.length };
}

// =============================================================================
// Reclassification: LLM-Powered Button
// =============================================================================

/**
 * Build a prompt for batch reclassification of is_transient.
 * @param {Array<{id: string, summary: string}>} memories - Memory summaries to classify
 * @returns {Array<{role: string, content: string}>} LLM messages
 */
function buildReclassificationPrompt(memories) {
    const memoryList = memories.map((m) => `id="${m.id}" summary="${m.summary}"`).join('\n');

    const systemPrompt = `You are a narrative memory classifier. Your task is to evaluate whether each memory below is "transient" (fleeting, mundane, cosmetic, single-moment, or low-stakes) or "lasting" (significant character development, plot events, relationship changes, world-state changes, revelations, or decisions with consequences).

A memory IS transient if ANY of these apply:
- Clothing/appearance choices (e.g., "decided to wear the black dress")
- Single-instance food/drink (e.g., "ordered a coffee", "ate breakfast")
- Momentary bodily actions (e.g., "sat down", "stood up", "stretched", "yawned")
- Fleeting emotional states that pass quickly (e.g., "felt a bit tired this morning")
- Casual observations (e.g., "glanced out the window", "noticed a bird")
- Minor conversational gestures (e.g., "smiled", "nodded", "chuckled")
- Mundane weather notes (e.g., "it was a bit cloudy today")
- Grooming/self-care routines (e.g., "brushed her hair", "took a shower")
- Single night sleep without significance (e.g., "went to bed")
- Briefly looking at something without consequence (e.g., "looked at the menu")

A memory is NOT transient (lasting) if:
- It reveals character information, backstory, or motivation
- It advances the plot or changes the situation
- It involves relationship development (confession, argument, trust-building)
- It changes the world state (a door is unlocked, an item is obtained)
- It involves a decision with consequences
- It contains emotional weight that persists
- It introduces new information relevant to the story
- It represents a significant event or milestone

Return ONLY a JSON array of objects with "id" and "is_transient" (boolean) fields. No other text.`;

    const userPrompt = `Classify each of these ${memories.length} memories as transient or lasting:\n\n${memoryList}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
}

/**
 * Heuristic truncation check: a complete JSON array/object has balanced brackets.
 * If the response (minus any code fence) has more openers than closers, the model's
 * output was cut off — almost always because it hit its completion-token limit. This
 * is the common failure mode with heavy "thinking" models on a too-small token budget.
 * @param {string} content - Raw LLM response (reasoning already stripped by callLLM)
 * @returns {boolean}
 */
function responseLooksTruncated(content) {
    if (!content) return false;
    let s = content;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) s = fence[1];
    const opens = (s.match(/[[{]/g) || []).length;
    const closes = (s.match(/[\]}]/g) || []).length;
    return opens > closes;
}

/**
 * Build a "response truncated" error that tells the user how to fix it.
 * Flagged with `isTruncation` so the retry loop skips it (a retry at the same budget
 * would just truncate again).
 * @param {number} maxTokens - The budget that was used
 * @returns {Error}
 */
function truncationError(maxTokens) {
    const err = new Error(
        `Reclassification response was cut off at the ${maxTokens}-token limit. ` +
            `This model likely uses heavy "thinking". Increase "Reclassify max tokens" and retry.`
    );
    /** @type {any} */ (err).isTruncation = true;
    /** @type {any} */ (err).maxTokens = maxTokens;
    return err;
}

/**
 * Process a single batch of memories through LLM reclassification with retry.
 * @param {Array<{id: string, summary: string}>} batch - Memory batch to classify
 * @param {number} batchNum - Current batch number (1-based)
 * @param {number} totalBatches - Total number of batches
 * @param {Object} deps - { updateMemory, applySyncChanges, callLLM }
 * @returns {Promise<{marked: number, unmarked: number, errors: number, cancelled: boolean}>}
 */
async function processReclassificationBatch(batch, batchNum, totalBatches, deps) {
    const { updateMemory, applySyncChanges, callLLM } = deps;
    const batchItems = batch.map((m) => ({ id: m.id, summary: m.summary || '' }));
    const messages = buildReclassificationPrompt(batchItems);
    const maxTokens =
        parseInt(getSettings('reclassifyMaxTokens', RECLASSIFY_DEFAULT_MAX_TOKENS), 10) ||
        RECLASSIFY_DEFAULT_MAX_TOKENS;

    const MAX_BATCH_RETRIES = 2;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
        try {
            const toastMsg =
                attempt > 0
                    ? `Retrying batch ${batchNum}/${totalBatches} (attempt ${attempt + 1}/${MAX_BATCH_RETRIES + 1})...`
                    : `Reclassifying batch ${batchNum}/${totalBatches}...`;
            showToast('info', toastMsg, undefined, { duration: 3000 });

            const response = await callLLM(
                messages,
                {
                    profileSettingKey: 'extractionProfile',
                    maxTokens,
                    errorContext: `Transient Reclassification (batch ${batchNum}/${totalBatches})`,
                    timeoutMs: 120000,
                    getJsonSchema: null,
                },
                {}
            );

            const truncated = responseLooksTruncated(response);
            const classificationMap = parseReclassificationResponse(response);

            if (!classificationMap) {
                if (truncated) throw truncationError(maxTokens);
                console.error('[OpenVault] Failed to parse reclassification response:', response.substring(0, 200));
                throw new Error(`Failed to parse reclassification response: ${response.substring(0, 200)}`);
            }

            // JSON repair can salvage a partial array from a truncated response — if the
            // result is short AND the raw output was cut off, treat it as truncation too.
            if (truncated && classificationMap.size < batch.length) {
                throw truncationError(maxTokens);
            }

            let marked = 0;
            let unmarked = 0;
            let errors = 0;

            for (const mem of batch) {
                const shouldBeTransient = classificationMap.get(mem.id);
                if (shouldBeTransient === undefined) {
                    errors++;
                    continue;
                }

                // Only update if the value actually changed
                const currentValue = !!mem.is_transient;
                if (shouldBeTransient !== currentValue) {
                    const result = await updateMemory(mem.id, { is_transient: shouldBeTransient });
                    if (result.success) {
                        if (result.stChanges) {
                            await applySyncChanges(result.stChanges);
                        }
                        if (shouldBeTransient) {
                            marked++;
                        } else {
                            unmarked++;
                        }
                    } else {
                        errors++;
                    }
                }
            }

            return { marked, unmarked, errors, cancelled: false };
        } catch (err) {
            lastError = err;
            if (err.name === 'AbortError') {
                showToast('warning', 'Reclassification cancelled');
                return { marked: 0, unmarked: 0, errors: 0, cancelled: true };
            }
            if (err.isTruncation) {
                // Retrying at the same token budget would just truncate again — bubble up.
                throw err;
            }
            if (attempt < MAX_BATCH_RETRIES) {
                console.warn(`[OpenVault] Batch ${batchNum} attempt ${attempt + 1} failed, retrying...`, err);
                await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    console.error(
        `[OpenVault] Reclassification batch ${batchNum} failed after ${MAX_BATCH_RETRIES + 1} attempts:`,
        lastError
    );
    return { marked: 0, unmarked: 0, errors: batch.length, cancelled: false };
}

/**
 * Shared core for LLM reclassification — used by both "Reclassify All" and "Reclassify Last N".
 * @param {Array<Object>} candidates - Memory candidates to reclassify
 * @param {string} confirmMessage - Confirmation dialog message
 * @returns {Promise<{marked: number, unmarked: number, errors: number}>}
 */
async function runLlmReclassification(candidates, confirmMessage) {
    if (candidates.length === 0) {
        showToast('info', 'No memories to reclassify');
        return { marked: 0, unmarked: 0, errors: 0 };
    }

    const BATCH_SIZE = 50;
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
    const estimatedCalls = totalBatches;
    const confirmMsg = `${confirmMessage}\n\nThis will use approximately ${estimatedCalls} API call${estimatedCalls !== 1 ? 's' : ''}.`;
    if (!confirm(confirmMsg)) {
        return { marked: 0, unmarked: 0, errors: 0 };
    }

    const { updateMemory } = await import('../store/chat-data.js');
    const { applySyncChanges } = await import('../extraction/extract.js');
    const { callLLM } = await import('../llm.js');
    const deps = { updateMemory, applySyncChanges, callLLM };

    let totalMarked = 0;
    let totalUnmarked = 0;
    let totalErrors = 0;

    // Process in batches
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        let result;
        try {
            result = await processReclassificationBatch(batch, batchNum, totalBatches, deps);
        } catch (err) {
            if (err.isTruncation) {
                // Every batch would truncate the same way — stop and tell the user how to fix it.
                showToast('error', err.message, 'OpenVault', { duration: 12000 });
                break;
            }
            throw err;
        }
        if (result.cancelled) break;

        totalMarked += result.marked;
        totalUnmarked += result.unmarked;
        totalErrors += result.errors;
    }

    const { refreshSidePanel } = await import('./side-panel.js');
    refreshSidePanel();

    const msgParts = [];
    if (totalMarked > 0) msgParts.push(`${totalMarked} marked transient`);
    if (totalUnmarked > 0) msgParts.push(`${totalUnmarked} unmarked (set to lasting)`);
    if (totalErrors > 0) msgParts.push(`${totalErrors} errors`);

    if (msgParts.length > 0) {
        showToast('success', `Reclassification complete: ${msgParts.join(', ')}`);
    } else {
        showToast('info', 'All memories already correctly classified');
    }

    return { marked: totalMarked, unmarked: totalUnmarked, errors: totalErrors };
}

/**
 * Reclassify all non-reflection, non-already-transient memories using an LLM call.
 * Processes in batches of 50 to stay within token limits.
 * @returns {Promise<{marked: number, unmarked: number, errors: number}>}
 */
export async function llmReclassifyTransient() {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { marked: 0, unmarked: 0, errors: 0 };
    }

    // Filter to non-reflection memories only, skip already-transient to save API calls
    const candidates = (data[MEMORIES_KEY] || []).filter((m) => m.type !== 'reflection' && !m.is_transient);

    return runLlmReclassification(candidates, `Send ${candidates.length} memories to the LLM for reclassification?`);
}

/**
 * Reclassify the most recent N non-reflection memories using an LLM call.
 * Sorts by created_at descending and takes the first N.
 * @param {number} [n=50] - Number of most recent memories to reclassify
 * @returns {Promise<{marked: number, unmarked: number, errors: number}>}
 */
export async function llmReclassifyLastN(n = 50) {
    n = Math.max(1, parseInt(n, 10) || 50);

    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { marked: 0, unmarked: 0, errors: 0 };
    }

    const allMemories = data[MEMORIES_KEY] || [];

    // Sort by created_at descending (most recent first), take top N
    const sorted = [...allMemories]
        .filter((m) => m.type !== 'reflection' && !m.is_transient)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    const candidates = sorted.slice(0, n);
    console.log('[OpenVault] Last N candidates:', candidates.length, 'from', allMemories.length, 'total memories');

    return runLlmReclassification(candidates, `Reclassify the ${candidates.length} most recent memories?`);
}

// =============================================================================
// Sanitization Helpers
// =============================================================================

/**
 * Deep-clone an object while stripping specified fields at all levels.
 * @param {any} obj - Object to sanitize
 * @param {string[]} stripFields - Field names to remove
 * @returns {any} Sanitized clone
 */
function sanitizeObject(obj, stripFields) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map((item) => sanitizeObject(item, stripFields));
    }
    const clone = {};
    for (const [key, value] of Object.entries(obj)) {
        if (stripFields.includes(key)) continue;
        clone[key] = sanitizeObject(value, stripFields);
    }
    return clone;
}

/**
 * Sanitize a memory object for export.
 * @param {Object} memory
 * @returns {Object}
 */
function sanitizeMemory(memory) {
    const clone = {};
    for (const [key, value] of Object.entries(memory)) {
        if (MEMORY_STRIP_FIELDS.includes(key)) continue;
        clone[key] = value;
    }
    // Also strip embedding from the top-level deleteEmbedding would handle
    deleteEmbedding(clone);
    return clone;
}

/**
 * Sanitize a graph node for export.
 * @param {Object} node
 * @returns {Object}
 */
function sanitizeNode(node) {
    const clone = {};
    for (const [key, value] of Object.entries(node)) {
        if (NODE_STRIP_FIELDS.includes(key)) continue;
        clone[key] = value;
    }
    deleteEmbedding(clone);
    return clone;
}

/**
 * Sanitize a graph edge for export.
 * @param {Object} edge
 * @returns {Object}
 */
function sanitizeEdge(edge) {
    const clone = {};
    for (const [key, value] of Object.entries(edge)) {
        if (EDGE_STRIP_FIELDS.includes(key)) continue;
        clone[key] = value;
    }
    deleteEmbedding(clone);
    return clone;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Build the full export payload.
 * @returns {Object} JSON-serializable export payload
 */
export function buildUserExportPayload() {
    const data = getOpenVaultData();
    if (!data) return null;

    const memories = (data[MEMORIES_KEY] || []).map(sanitizeMemory);
    const characters = sanitizeObject(data[CHARACTERS_KEY] || {}, CHARACTER_STRIP_FIELDS);
    const communities = sanitizeObject(data.communities || {}, COMMUNITY_STRIP_FIELDS);

    // Build sanitized graph
    const graph = data.graph || {};
    const nodes = {};
    for (const [key, node] of Object.entries(graph.nodes || {})) {
        nodes[key] = sanitizeNode(node);
    }
    const edges = {};
    for (const [key, edge] of Object.entries(graph.edges || {})) {
        edges[key] = sanitizeEdge(edge);
    }
    // Strip graph metadata
    const graphMeta = {};
    for (const [key, value] of Object.entries(graph)) {
        if (key === 'nodes' || key === 'edges') continue;
        if (GRAPH_META_STRIP_FIELDS.includes(key)) continue;
        graphMeta[key] = value;
    }

    return {
        _openvault_export: true,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        memories,
        characters,
        graph: { ...graphMeta, nodes, edges },
        communities,
        globalWorldState: data.global_world_state || null,
        embeddingModelId: data.embedding_model_id || null,
    };
}

/**
 * Trigger a file download of the export payload.
 */
export function exportMemoriesToFile() {
    try {
        const payload = buildUserExportPayload();
        if (!payload) {
            showToast('warning', 'No data to export');
            return;
        }

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `openvault-export-${timestamp}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const memoriesCount = payload.memories.length;
        const entitiesCount = Object.keys(payload.graph.nodes).length;
        const edgesCount = Object.keys(payload.graph.edges).length;
        showToast(
            'success',
            `Exported ${memoriesCount} memories, ${entitiesCount} entities, ${edgesCount} relationships`
        );
    } catch (err) {
        console.error('[OpenVault] Export failed:', err);
        showToast('error', `Export failed: ${err.message}`);
    }
}

// =============================================================================
// Import
// =============================================================================

/**
 * Validate an import payload's structure.
 * @param {Object} payload - Parsed JSON
 * @returns {{ valid: boolean, error?: string, stats?: { memories: number, entities: number, edges: number, communities: number } }}
 */
function validateImportPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Invalid file: not a valid JSON object' };
    }

    if (!payload._openvault_export) {
        return { valid: false, error: 'Invalid file: not an OpenVault export' };
    }

    if (!Array.isArray(payload.memories)) {
        return { valid: false, error: 'Invalid file: missing or invalid memories array' };
    }

    // Validate each memory has at least id + summary
    for (const mem of payload.memories) {
        if (!mem.id || !mem.summary) {
            return { valid: false, error: 'Invalid file: memories missing required fields (id, summary)' };
        }
    }

    // Validate graph if present
    const nodes = payload.graph?.nodes || {};
    const edges = payload.graph?.edges || {};
    for (const [key, node] of Object.entries(nodes)) {
        if (!node.name) {
            return { valid: false, error: `Invalid file: graph node "${key}" missing name` };
        }
    }

    return {
        valid: true,
        stats: {
            memories: payload.memories.length,
            entities: Object.keys(nodes).length,
            edges: Object.keys(edges).length,
            communities: payload.communities ? Object.keys(payload.communities).length : 0,
        },
    };
}

/**
 * Import memories from a JSON file with merge or replace strategy.
 * @param {File} file - The uploaded file
 * @param {'merge'|'replace'} strategy - Import strategy
 */
export async function importMemoriesFromFile(file, strategy) {
    try {
        const text = await file.text();
        const payload = JSON.parse(text);

        const validation = validateImportPayload(payload);
        if (!validation.valid) {
            showToast('error', validation.error);
            return;
        }

        const { stats } = validation;

        // Confirm with user
        const action = strategy === 'replace' ? 'Replace all existing data' : 'Merge with existing data';
        const confirmMsg =
            `Import ${stats.memories} memories, ${stats.entities} entities, ` +
            `${stats.edges} relationships, ${stats.communities} communities?\n\n` +
            `Strategy: ${action}`;
        if (!confirm(confirmMsg)) return;

        const data = getOpenVaultData();
        if (!data) {
            showToast('warning', 'No chat loaded');
            return;
        }

        if (strategy === 'replace') {
            // Clear existing data
            data[MEMORIES_KEY] = [];
            if (payload.graph) {
                data.graph = {
                    nodes: {},
                    edges: {},
                    _mergeRedirects: {},
                    _edgesNeedingConsolidation: [],
                };
            }
            data.communities = {};
            data[CHARACTERS_KEY] = {};
            data.global_world_state = null;
            data.embedding_model_id = null;
            data.graph_message_count = 0;
        }

        // Merge/import memories (skip duplicates by ID)
        const existingIds = new Set((data[MEMORIES_KEY] || []).map((m) => m.id));
        let importedMemories = 0;
        for (const mem of payload.memories) {
            if (!existingIds.has(mem.id)) {
                data[MEMORIES_KEY].push(mem);
                existingIds.add(mem.id);
                importedMemories++;
            }
        }

        // Merge/import graph nodes
        if (payload.graph?.nodes) {
            data.graph = data.graph || { nodes: {}, edges: {} };
            let _importedNodes = 0;
            for (const [key, node] of Object.entries(payload.graph.nodes)) {
                if (!data.graph.nodes[key]) {
                    data.graph.nodes[key] = node;
                    _importedNodes++;
                }
            }

            // Merge/import graph edges
            let _importedEdges = 0;
            if (payload.graph.edges) {
                for (const [key, edge] of Object.entries(payload.graph.edges)) {
                    if (!data.graph.edges[key]) {
                        data.graph.edges[key] = edge;
                        _importedEdges++;
                    }
                }
            }

            // Import communities if merging
            if (payload.communities) {
                data.communities = data.communities || {};
                let _importedCommunities = 0;
                for (const [key, community] of Object.entries(payload.communities)) {
                    if (!data.communities[key]) {
                        data.communities[key] = community;
                        _importedCommunities++;
                    }
                }
            }
        }

        // Import character states
        if (payload.characters) {
            data[CHARACTERS_KEY] = data[CHARACTERS_KEY] || {};
            for (const [key, state] of Object.entries(payload.characters)) {
                if (!data[CHARACTERS_KEY][key]) {
                    data[CHARACTERS_KEY][key] = state;
                }
            }
        }

        // Import global world state if merging and if absent
        if (strategy === 'merge' && payload.globalWorldState && !data.global_world_state) {
            data.global_world_state = payload.globalWorldState;
        }
        if (strategy === 'merge' && payload.embeddingModelId && !data.embedding_model_id) {
            data.embedding_model_id = payload.embeddingModelId;
        }

        await saveOpenVaultData();

        const totalCount = stats.memories;
        showToast(
            'success',
            `Imported ${importedMemories}/${totalCount} new memories (${strategy === 'replace' ? 'replaced' : 'merged'})`
        );

        // Request UI refresh
        const { refreshSidePanel } = await import('./side-panel.js');
        refreshSidePanel();
    } catch (err) {
        console.error('[OpenVault] Import failed:', err);
        showToast('error', `Import failed: ${err.message}`);
    }
}

// =============================================================================
// Render: Export/Import Panel
// =============================================================================

/**
 * Render the export/import management panel.
 * @param {HTMLElement|string} container - DOM element or CSS selector
 */
export function renderExportImportPanel(container) {
    if (typeof container === 'string') {
        container = document.querySelector(container) || document.getElementById(container);
    }
    if (!container) return;

    const data = getOpenVaultData();
    const memoryCount = data?.[MEMORIES_KEY]?.length || 0;
    const entityCount = data?.graph?.nodes ? Object.keys(data.graph.nodes).length : 0;
    const communityCount = data?.communities ? Object.keys(data.communities).length : 0;

    // Count transient vs lasting
    const transientCount = (data?.[MEMORIES_KEY] || []).filter((m) => m.is_transient).length;
    const lastingCount = memoryCount - transientCount;

    container.innerHTML = `
        <div class="openvault-export-import-panel">
            <div class="openvault-ei-section">
                <h3><i class="fa-solid fa-database"></i> Database Overview</h3>
                <div class="openvault-ei-stats">
                    <div class="openvault-ei-stat">
                        <span class="openvault-ei-stat-value">${memoryCount}</span>
                        <span class="openvault-ei-stat-label">Memories</span>
                    </div>
                    <div class="openvault-ei-stat">
                        <span class="openvault-ei-stat-value">${entityCount}</span>
                        <span class="openvault-ei-stat-label">Entities</span>
                    </div>
                    <div class="openvault-ei-stat">
                        <span class="openvault-ei-stat-value">${communityCount}</span>
                        <span class="openvault-ei-stat-label">Communities</span>
                    </div>
                </div>
                <div class="openvault-ei-stats" style="margin-top: 8px;">
                    <div class="openvault-ei-stat">
                        <span class="openvault-ei-stat-value" style="color: #f59e0b;">${transientCount}</span>
                        <span class="openvault-ei-stat-label">Transient</span>
                    </div>
                    <div class="openvault-ei-stat">
                        <span class="openvault-ei-stat-value">${lastingCount}</span>
                        <span class="openvault-ei-stat-label">Lasting</span>
                    </div>
                </div>
            </div>

            <div class="openvault-ei-section">
                <h3><i class="fa-solid fa-wind"></i> Reclassify Transient Flags</h3>
                <p class="openvault-ei-desc">
                    Fix memories that should have been marked transient but weren't.
                    <strong>Quick Mark</strong> uses pattern matching (instant, no API cost).
                    <strong>AI Reclassify</strong> sends memories to the LLM for deeper analysis (uses API calls).
                </p>
                <div class="openvault-ei-actions">
                    <button class="openvault-btn openvault-export-import-btn" data-action="heuristic-reclassify">
                        <i class="fa-solid fa-bolt"></i> Quick Mark (Pattern Match)
                    </button>
                    <button class="openvault-btn openvault-export-import-btn" data-action="llm-reclassify">
                        <i class="fa-solid fa-brain"></i> AI Reclassify All
                    </button>
                </div>
                <div class="openvault-ei-actions" style="margin-top: 8px;">
                    <label class="openvault-reclassify-lastn-label">
                        <span>Last</span>
                        <input type="number" id="openvault-reclassify-lastn-count" value="50" min="1" max="9999" step="10" class="openvault-reclassify-lastn-input">
                        <span>memories</span>
                    </label>
                    <button class="openvault-btn openvault-export-import-btn" data-action="llm-reclassify-lastn">
                        <i class="fa-solid fa-brain"></i> AI Reclassify Last N
                    </button>
                </div>
                <div class="openvault-ei-actions" style="margin-top: 8px;">
                    <label class="openvault-reclassify-lastn-label" title="Completion budget per AI Reclassify call. Raise this only if reclassify reports truncation — heavy 'thinking' models need more headroom. Keep it modest for small models.">
                        <span>Max tokens</span>
                        <input type="number" id="openvault-reclassify-max-tokens" value="${getSettings('reclassifyMaxTokens', RECLASSIFY_DEFAULT_MAX_TOKENS)}" min="512" max="65536" step="512" class="openvault-reclassify-lastn-input">
                    </label>
                </div>
            </div>

            <div class="openvault-ei-section">
                <h3><i class="fa-solid fa-file-export"></i> Export</h3>
                <p class="openvault-ei-desc">Download your memory database as a portable JSON file. Strips embeddings and internal fields.</p>
                <div class="openvault-ei-actions">
                    <button class="openvault-btn openvault-export-import-btn" data-action="export">
                        <i class="fa-solid fa-download"></i> Download Export
                    </button>
                    <button class="openvault-btn openvault-export-import-btn" data-action="copy">
                        <i class="fa-solid fa-copy"></i> Copy to Clipboard
                    </button>
                </div>
            </div>

            <div class="openvault-ei-section">
                <h3><i class="fa-solid fa-file-import"></i> Import</h3>
                <p class="openvault-ei-desc">Import memories from a previously exported JSON file. Duplicate IDs are skipped.</p>
                <div class="openvault-ei-actions">
                    <button class="openvault-btn openvault-export-import-btn" data-action="import">
                        <i class="fa-solid fa-upload"></i> Import from File
                    </button>
                </div>
            </div>

            <div class="openvault-ei-section openvault-ei-danger">
                <h3><i class="fa-solid fa-triangle-exclamation"></i> Danger Zone</h3>
                <p class="openvault-ei-desc">Permanently delete all memories from this chat. Consider exporting first.</p>
                <div class="openvault-ei-actions">
                    <button class="openvault-btn openvault-btn-danger openvault-export-import-btn" data-action="clear">
                        <i class="fa-solid fa-trash"></i> Clear All Memories
                    </button>
                </div>
            </div>
        </div>
    `;

    // Persist the reclassify token budget when the user changes it.
    const maxTokensInput = container.querySelector('#openvault-reclassify-max-tokens');
    if (maxTokensInput) {
        maxTokensInput.addEventListener('change', () => {
            const v = parseInt(maxTokensInput.value, 10);
            if (Number.isFinite(v) && v >= 512) {
                setSetting('reclassifyMaxTokens', v);
            }
        });
    }
}

export function openImportPicker(strategy) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';

    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        await importMemoriesFromFile(file, strategy);
        input.remove();
    });

    // Handle cancel (no file selected)
    input.addEventListener('cancel', () => input.remove());

    document.body.appendChild(input);
    input.click();
}
