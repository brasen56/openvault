// @ts-check

import {
    CANON_NOTES_KEY,
    CHARACTERS_KEY,
    CONSOLIDATION,
    EMBEDDING_SOURCES,
    ENTITY_TYPES,
    GRAPH_JACCARD_DUPLICATE_THRESHOLD,
    MEMORIES_KEY,
    METADATA_KEY,
    PROCESSED_MESSAGES_KEY,
} from '../constants.js';
import { getDeps } from '../deps.js';
import { createEmptyGraph, normalizeKey } from '../graph/graph.js';
import { record } from '../perf/store.js';
import { purgeSTCollection } from '../services/st-vector.js';
import { showToast } from '../utils/dom.js';
import { cyrb53, deleteEmbedding } from '../utils/embedding-codec.js';
import { logDebug, logError, logInfo, logWarn } from '../utils/logging.js';
import { yieldToMain } from '../utils/st-helpers.js';
import { mergeDescriptions } from '../utils/text.js';
import { countTokens } from '../utils/tokens.js';

/** @typedef {import('../types.d.ts').OpenVaultData} OpenVaultData */
/** @typedef {import('../types.d.ts').Memory} Memory */
/** @typedef {import('../types.d.ts').MemoryUpdate} MemoryUpdate */

/**
 * Get OpenVault data from chat metadata.
 * @returns {OpenVaultData | null} Returns null if context is not available
 */
export function getOpenVaultData() {
    const context = getDeps().getContext();
    if (!context) {
        logWarn('getContext() returned null/undefined');
        return null;
    }
    if (!context.chatMetadata) {
        context.chatMetadata = {};
    }
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = {
            schema_version: 3,
            [MEMORIES_KEY]: [],
            [CHARACTERS_KEY]: {},
            [PROCESSED_MESSAGES_KEY]: [],
            reflection_state: {},
            graph: createEmptyGraph(),
            communities: {},
            graph_message_count: 0,
            contradiction_analyzed: {},
            [CANON_NOTES_KEY]: {},
        };
    }
    const data = context.chatMetadata[METADATA_KEY];

    return data;
}

/**
 * Get current chat ID for tracking across async operations.
 * @returns {string | null} Chat ID or null if unavailable
 */
export function getCurrentChatId() {
    const context = getDeps().getContext();
    return context?.chatId || context?.chat_metadata?.chat_id || null;
}

/**
 * Save OpenVault data to chat metadata.
 * @param {string} [expectedChatId] - If provided, verify chat hasn't changed before saving
 * @returns {Promise<boolean>} True if save succeeded, false otherwise
 */
export async function saveOpenVaultData(expectedChatId = null) {
    const t0 = performance.now();
    if (expectedChatId !== null) {
        const currentId = getCurrentChatId();
        if (currentId !== expectedChatId) {
            logWarn(
                `Chat changed during operation (expected: ${expectedChatId}, current: ${currentId}), aborting save`
            );
            return false;
        }
    }

    try {
        await yieldToMain(); // Yield before ST's heavy synchronous save
        await getDeps().saveChatConditional();
        await yieldToMain(); // Yield after the thread-blocking operation
        record('chat_save', performance.now() - t0);
        logDebug('Data saved to chat metadata');
        return true;
    } catch (error) {
        record('chat_save', performance.now() - t0);
        logError('Failed to save data', error);
        showToast('error', `Failed to save data: ${error.message}`);
        return false;
    }
}

/**
 * Generate a unique ID.
 * @returns {string} Unique ID string
 */
export function generateId() {
    return `${getDeps().Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Update a memory by ID.
 * @param {string} id - Memory ID to update
 * @param {MemoryUpdate} updates - Fields to update
 * @returns {Promise<{success: boolean, stChanges?: {toSync?: {hash: number, text: string, item: Memory}[]}}>} Result with success flag and optional ST Vector changes
 */
export async function updateMemory(id, updates) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { success: false };
    }

    const memory = data[MEMORIES_KEY]?.find((/** @type {Memory} */ m) => m.id === id);
    if (!memory) {
        logDebug(`Memory ${id} not found`);
        return { success: false };
    }

    // Track if summary changed (requires re-embedding)
    const summaryChanged = updates.summary !== undefined && updates.summary !== memory.summary;

    // Apply allowed updates
    const allowedFields = [
        'summary',
        'importance',
        'tags',
        'is_secret',
        'temporal_anchor',
        'is_transient',
        'witnesses',
        'characters_involved',
    ];
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            memory[field] = updates[field];
        }
    }

    const stChanges = {};

    // If summary changed, invalidate embedding and queue for re-sync
    if (summaryChanged) {
        deleteEmbedding(memory);
        const text = memory.summary || '';
        stChanges.toSync = [{ hash: cyrb53(text), text, item: memory }];
    }

    await getDeps().saveChatConditional();
    logDebug(`Updated memory ${id}${summaryChanged ? ' (embedding invalidated)' : ''}`);
    return {
        success: true,
        stChanges: Object.keys(stChanges).length > 0 ? stChanges : undefined,
    };
}

/**
 * Delete a memory by ID.
 * @param {string} id - Memory ID to delete
 * @returns {Promise<{success: boolean, stChanges?: {toDelete: {hash: number}[]}}>} Result with success flag and optional ST Vector changes
 */
export async function deleteMemory(id) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { success: false };
    }

    const idx = data[MEMORIES_KEY]?.findIndex((/** @type {Memory} */ m) => m.id === id) ?? -1;
    if (idx === -1) {
        logDebug(`Memory ${id} not found`);
        return { success: false };
    }

    const memory = data[MEMORIES_KEY][idx];
    const stChanges = {};

    // Queue for ST Vector deletion if previously synced
    if (memory._st_synced) {
        const text = memory.summary || '';
        stChanges.toDelete = [{ hash: cyrb53(text) }];
    }

    data[MEMORIES_KEY].splice(idx, 1);
    await getDeps().saveChatConditional();
    logDebug(`Deleted memory ${id}`);
    return {
        success: true,
        stChanges: Object.keys(stChanges).length > 0 ? stChanges : undefined,
    };
}

/**
 * Update an entity's fields. Handles rename by rewriting edges and merge redirects.
 * @param {string} key - Current normalized entity key
 * @param {Object} updates - { name?, type?, description?, aliases? }
 * @returns {Promise<{key: string, stChanges?: {toDelete?: {hash: number}[], toSync?: {hash: number, text: string, item: any}[]}}|null>} Result with new key and optional ST Vector changes, null on failure
 */
export async function updateEntity(key, updates) {
    const { saveChatConditional } = getDeps();
    const graph = getOpenVaultData().graph;
    const node = graph.nodes[key];

    if (!node) {
        logWarn(`Cannot update entity: ${key} not found`);
        return null;
    }

    // Determine if renaming
    const newName = updates.name ?? node.name;
    const newKey = normalizeKey(newName);

    // If renaming, check for collision
    if (newKey !== key) {
        if (graph.nodes[newKey]) {
            logWarn(`Cannot rename to '${newName}': entity already exists`);
            return null;
        }
    }

    if (newKey !== key) {
        // Track old hash for ST Vector deletion if synced
        const toDelete = [];
        if (node._st_synced) {
            // Calculate hash using same format as insertion in graph.js:486:
            // [OV_ID:key] description (no fallback to name)
            const text = `[OV_ID:${key}] ${node.description}`;
            toDelete.push({ hash: cyrb53(text) });
        }

        // Create new node with updated fields
        graph.nodes[newKey] = {
            ...node,
            name: newName,
            type: updates.type ?? node.type,
            description: updates.description ?? node.description,
            aliases: updates.aliases ?? node.aliases ?? [],
        };

        // Delete old node
        delete graph.nodes[key];

        // Rewrite edges
        for (const [edgeKey, edge] of Object.entries(graph.edges)) {
            let needsRewrite = false;
            let newSource = edge.source;
            let newTarget = edge.target;

            if (edge.source === key) {
                newSource = newKey;
                needsRewrite = true;
            }
            if (edge.target === key) {
                newTarget = newKey;
                needsRewrite = true;
            }

            if (needsRewrite) {
                const newEdgeKey = `${newSource}__${newTarget}`;

                // Queue old edge for ST Vector deletion if synced
                if (edge._st_synced) {
                    toDelete.push({ hash: cyrb53(`[OV_ID:edge_${edge.source}_${edge.target}] ${edge.description}`) });
                }

                delete graph.edges[edgeKey];
                const newEdge = {
                    ...edge,
                    source: newSource,
                    target: newTarget,
                };
                deleteEmbedding(newEdge);
                graph.edges[newEdgeKey] = newEdge;
            }
        }

        // Guard _mergeRedirects (matches pattern in graph.js:272)
        if (!graph._mergeRedirects) graph._mergeRedirects = {};
        graph._mergeRedirects[key] = newKey;

        // Fix any existing redirects that still point to oldKey.
        // _resolveKey() is non-recursive, so chained redirects
        // (A → oldKey → newKey) would resolve A to a deleted node.
        for (const [rk, rv] of Object.entries(graph._mergeRedirects)) {
            if (rv === key && rk !== key) {
                graph._mergeRedirects[rk] = newKey;
            }
        }

        // Invalidate embedding on new node
        deleteEmbedding(graph.nodes[newKey]);

        await saveChatConditional();
        return {
            key: newKey,
            stChanges: toDelete.length > 0 ? { toDelete } : undefined,
        };
    } else {
        // Simple field update, no rename
        Object.assign(node, {
            type: updates.type ?? node.type,
            description: updates.description ?? node.description,
            aliases: updates.aliases ?? node.aliases ?? [],
        });

        // Invalidate embedding on description change
        if (updates.description !== undefined) {
            deleteEmbedding(node);
        }

        await saveChatConditional();

        // Return stChanges for ST Vector sync if description changed
        const toSync = [];
        if (updates.description !== undefined) {
            const text = `[OV_ID:${key}] ${node.description}`;
            toSync.push({ hash: cyrb53(text), text, item: node });
        }

        return { key, stChanges: toSync.length > 0 ? { toSync } : undefined };
    }
}

/**
 * Delete an entity and all its edges and merge redirects.
 * Also deletes from ST Vector storage if _st_synced to prevent orphan embeddings.
 * @param {string} key - Normalized entity key
 * @returns {Promise<{success: boolean, stChanges?: {toDelete: {hash: number}[]}}>}
 */
export async function deleteEntity(key) {
    const { saveChatConditional } = getDeps();
    const graph = getOpenVaultData().graph;

    const node = graph.nodes[key];
    if (!node) {
        logWarn(`Cannot delete entity: ${key} not found`);
        return { success: false };
    }

    // Track ST Vector items to delete (prevent orphan embeddings)
    const toDelete = [];
    if (node._st_synced) {
        // Calculate hash using same format as insertion in graph.js:486:
        // [OV_ID:key] description (no fallback to name)
        const text = `[OV_ID:${key}] ${node.description}`;
        toDelete.push({ hash: cyrb53(text) });
    }

    // Delete the node
    delete graph.nodes[key];

    // Remove all edges connected to this entity
    for (const [edgeKey, edge] of Object.entries(graph.edges)) {
        if (edge.source === key || edge.target === key) {
            delete graph.edges[edgeKey];
        }
    }

    // Guard _mergeRedirects before iterating (matches graph.js:272)
    if (graph._mergeRedirects) {
        for (const [redirectKey, redirectValue] of Object.entries(graph._mergeRedirects)) {
            if (redirectKey === key || redirectValue === key) {
                delete graph._mergeRedirects[redirectKey];
            }
        }
    }

    await saveChatConditional();

    return {
        success: true,
        stChanges: toDelete.length > 0 ? { toDelete } : undefined,
    };
}

/**
 * Remove a character from the CHARACTERS_KEY state and all memories
 * associated with that character. This is destructive and cannot be undone.
 * @param {string} charName - The exact character name to delete
 * @returns {Promise<{success: boolean, deletedMemories: number}>} Result with count of deleted memories
 */
export async function deleteCharacter(charName) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return { success: false, deletedMemories: 0 };
    }

    const charState = data[CHARACTERS_KEY]?.[charName];
    if (!charState) {
        logDebug(`Character "${charName}" not found in character states`);
        return { success: false, deletedMemories: 0 };
    }

    // Remove the character state entry
    delete data[CHARACTERS_KEY][charName];

    // Remove all memories that ONLY involve this character
    // A memory may involve multiple characters; we only strip this character's
    // name from the characters_involved list rather than deleting the memory.
    const memories = data[MEMORIES_KEY] || [];
    let affectedMemories = 0;
    for (const mem of memories) {
        const involved = mem.characters_involved || [];
        const idx = involved.indexOf(charName);
        if (idx !== -1) {
            involved.splice(idx, 1);
            affectedMemories++;
        }
    }

    // Also purge from reflection state
    if (data.reflection_state?.[charName]) {
        delete data.reflection_state[charName];
    }

    await getDeps().saveChatConditional();
    logInfo(`Deleted character "${charName}" — removed from ${affectedMemories} memories`);

    return { success: true, deletedMemories: affectedMemories };
}

/**
 * Delete all OpenVault data for the current chat.
 * @returns {Promise<boolean>} True if deleted, false otherwise
 */
export async function deleteCurrentChatData() {
    const context = getDeps().getContext();

    if (!context.chatMetadata) {
        logDebug('No chat metadata found');
        return false;
    }

    // Unhide all messages that were hidden by auto-hide
    // is_system flags persist even when memories are cleared, which would
    // leave those messages permanently unextractable
    const chat = context.chat || [];
    let unhiddenCount = 0;
    for (const msg of chat) {
        if (msg.openvault_hidden && msg.is_system) {
            msg.is_system = false;
            delete msg.openvault_hidden;
            unhiddenCount++;
        }
    }
    if (unhiddenCount > 0) {
        logDebug(`Unhid ${unhiddenCount} messages after memory clear`);
    }

    // Purge ST Vector Storage if using st_vector
    const settings = getDeps().getExtensionSettings()?.openvault;
    if (settings?.embeddingSource === EMBEDDING_SOURCES.ST_VECTOR) {
        const chatId = getCurrentChatId();
        if (chatId) {
            try {
                const purged = await purgeSTCollection(chatId);
                if (!purged) {
                    logWarn('Failed to purge ST collection during chat data deletion', new Error('Purge failed'));
                } else {
                    logInfo(`Purged ST Vector collection for cleared chat: ${chatId}`);
                }
            } catch (err) {
                logWarn('Failed to purge ST collection during chat data deletion', err);
                // Don't fail the whole operation - OpenVault data is already cleared
            }
        }
    }

    delete context.chatMetadata[METADATA_KEY];
    await getDeps().saveChatConditional();
    logDebug('Deleted all chat data');
    return true;
}

/**
 * Update a community by ID.
 * @param {string} id - Community ID (e.g. "C0")
 * @param {Object} updates - Fields to update (title, summary, findings)
 * @returns {Promise<boolean>} True if updated, false otherwise
 */
export async function updateCommunity(id, updates) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return false;
    }

    const community = data.communities?.[id];
    if (!community) {
        logDebug(`Community ${id} not found`);
        return false;
    }

    const summaryChanged = updates.summary !== undefined && updates.summary !== community.summary;

    const allowedFields = ['title', 'summary', 'findings'];
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            community[field] = updates[field];
        }
    }

    if (summaryChanged) {
        deleteEmbedding(community);
    }

    await getDeps().saveChatConditional();
    logDebug(`Updated community ${id}${summaryChanged ? ' (embedding invalidated)' : ''}`);
    return true;
}

/**
 * Delete a community by ID.
 * @param {string} id - Community ID (e.g. "C0")
 * @returns {Promise<boolean>} True if deleted, false otherwise
 */
export async function deleteCommunity(id) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return false;
    }

    if (!data.communities?.[id]) {
        logDebug(`Community ${id} not found`);
        return false;
    }

    delete data.communities[id];
    await getDeps().saveChatConditional();
    logDebug(`Deleted community ${id}`);
    return true;
}

/**
 * Bulk archive memories (soft delete). Sets archived=true on each matching memory.
 * Archived memories are excluded from retrieval/injection but remain in the data.
 * @param {string[]} ids - Array of memory IDs to archive
 * @returns {Promise<{success: boolean, count: number}>} Result with count of archived memories
 */
export async function archiveMemories(ids) {
    const data = getOpenVaultData();
    if (!data) return { success: false, count: 0 };
    const set = new Set(ids);
    let count = 0;
    for (const m of data[MEMORIES_KEY] || []) {
        if (set.has(m.id) && !m.archived) {
            m.archived = true;
            count++;
        }
    }
    if (count > 0) {
        await getDeps().saveChatConditional();
        logDebug(`Archived ${count} memories`);
    }
    return { success: true, count };
}

/**
 * Bulk unarchive memories (reverse soft delete). Sets archived=false on each matching memory.
 * @param {string[]} ids - Array of memory IDs to unarchive
 * @returns {Promise<{success: boolean, count: number}>} Result with count of unarchived memories
 */
export async function unarchiveMemories(ids) {
    const data = getOpenVaultData();
    if (!data) return { success: false, count: 0 };
    const set = new Set(ids);
    let count = 0;
    for (const m of data[MEMORIES_KEY] || []) {
        if (set.has(m.id) && m.archived) {
            m.archived = false;
            count++;
        }
    }
    if (count > 0) {
        await getDeps().saveChatConditional();
        logDebug(`Unarchived ${count} memories`);
    }
    return { success: true, count };
}

// =============================================================================
// Canon Notes (Phase 3 correction loop)
// =============================================================================
// Per-character authoritative corrections, stored as
// Record<characterName, CanonNote[]> and injected into the reflection prompt
// as a hard negative constraint so a marked-wrong synthesis drift (e.g.
// "demands ASL") does not regenerate. "Mark wrong" on a reflection only
// archives the memory (see archiveMemories above); the canon note is the
// durable steering that keeps the corrected theme from re-entrenching.

/**
 * Read a character's canon notes (authoritative corrections). Defensive against
 * unmigrated data: materializes an empty list on first read.
 * @param {string} characterName - Character display name
 * @returns {import('../types.d.ts').CanonNote[]}
 */
export function getCanonNotes(characterName) {
    const data = getOpenVaultData();
    if (!data) return [];
    if (!data[CANON_NOTES_KEY] || typeof data[CANON_NOTES_KEY] !== 'object') {
        data[CANON_NOTES_KEY] = {};
    }
    return data[CANON_NOTES_KEY][characterName] || [];
}

/**
 * Add an authoritative correction (canon note) for a character. Steers
 * reflection away from a marked-wrong synthesis drift.
 * @param {string} characterName - Character display name
 * @param {string} text - The correction text
 * @returns {Promise<{success: boolean, note?: import('../types.d.ts').CanonNote}>}
 */
export async function addCanonNote(characterName, text) {
    const data = getOpenVaultData();
    if (!data) return { success: false };
    const trimmed = String(text || '').trim();
    if (!trimmed) return { success: false };

    if (!data[CANON_NOTES_KEY] || typeof data[CANON_NOTES_KEY] !== 'object') {
        data[CANON_NOTES_KEY] = {};
    }
    const notes = (data[CANON_NOTES_KEY][characterName] ??= []);
    const note = {
        id: `canon_${generateId()}`,
        text: trimmed,
        created_at: getDeps().Date.now(),
    };
    notes.push(note);
    await getDeps().saveChatConditional();
    logDebug(`Added canon note for ${characterName}`);
    return { success: true, note };
}

/**
 * Remove an authoritative correction (canon note) by id.
 * @param {string} characterName - Character display name
 * @param {string} noteId - The canon note id
 * @returns {Promise<boolean>} True if a note was removed
 */
export async function removeCanonNote(characterName, noteId) {
    const data = getOpenVaultData();
    if (!data) return false;
    const notes = data[CANON_NOTES_KEY]?.[characterName];
    if (!Array.isArray(notes)) return false;

    const filtered = notes.filter((n) => n.id !== noteId);
    if (filtered.length === notes.length) return false;

    data[CANON_NOTES_KEY][characterName] = filtered;
    await getDeps().saveChatConditional();
    logDebug(`Removed canon note ${noteId} for ${characterName}`);
    return true;
}

/**
 * Bulk hard delete memories. Aggregates ST Vector changes into one save.
 * Also cascades: cleans orphan source_ids/parent_ids on remaining reflections.
 * @param {string[]} ids - Array of memory IDs to permanently delete
 * @returns {Promise<{success: boolean, count: number, stChanges?: {toDelete: {hash: number}[]}}>} Result with count and optional ST Vector changes
 */
export async function deleteMemories(ids) {
    const data = getOpenVaultData();
    if (!data) return { success: false, count: 0 };
    const set = new Set(ids);
    const toDelete = [];
    const before = data[MEMORIES_KEY].length;

    data[MEMORIES_KEY] = data[MEMORIES_KEY].filter((m) => {
        if (!set.has(m.id)) return true;
        if (m._st_synced) toDelete.push({ hash: cyrb53(m.summary || '') });
        return false;
    });

    // Cascade: clean orphan source_ids and parent_ids on remaining reflections
    for (const m of data[MEMORIES_KEY]) {
        if (m.type === 'reflection') {
            if (m.source_ids) m.source_ids = m.source_ids.filter((id) => !set.has(id));
            if (m.parent_ids) m.parent_ids = m.parent_ids.filter((id) => !set.has(id));
        }
    }

    const count = before - data[MEMORIES_KEY].length;
    if (count > 0) {
        await getDeps().saveChatConditional();
        logDebug(`Bulk deleted ${count} memories`);
    }
    return {
        success: true,
        count,
        stChanges: toDelete.length ? { toDelete } : undefined,
    };
}

/**
 * Append new memories to the store.
 * @param {Memory[]} newMemories - Memory objects to add
 * @returns {void}
 */
export function addMemories(newMemories) {
    const data = getOpenVaultData();
    if (!data || newMemories.length === 0) return;
    data[MEMORIES_KEY] = data[MEMORIES_KEY] || [];
    data[MEMORIES_KEY].push(...newMemories);
}

/**
 * Record message fingerprints as processed.
 * @param {string[]} fingerprints - Message fingerprints to mark
 * @returns {void}
 */
export function markMessagesProcessed(fingerprints) {
    const data = getOpenVaultData();
    if (!data || fingerprints.length === 0) return;
    data[PROCESSED_MESSAGES_KEY] = data[PROCESSED_MESSAGES_KEY] || [];
    data[PROCESSED_MESSAGES_KEY].push(...fingerprints);
}

/**
 * Increment the graph message count.
 * @param {number} count - Number of messages to add
 * @returns {void}
 */
export function incrementGraphMessageCount(count) {
    const data = getOpenVaultData();
    if (!data) return;
    data.graph_message_count = (data.graph_message_count || 0) + count;
}

/**
 * Reconcile the display-name-keyed stores when two characters are merged.
 *
 * The graph is keyed by normalized key, but `character_states`, `reflection_state`,
 * and the character fields on memories are keyed by display name — so merging two
 * graph nodes (via mergeEntities) leaves those stores split. This migrates every
 * reference from `sourceName` onto `targetName`. Matching is case-insensitive so it
 * also catches historical case/variant drift; the replacement is always the exact
 * `targetName`. Pure (operates on the passed data object) for testability.
 *
 * @param {OpenVaultData} data - OpenVault data object (mutated)
 * @param {string} sourceName - Display name being absorbed
 * @param {string} targetName - Surviving display name
 * @returns {void}
 */
export function reconcileCharacterIdentity(data, sourceName, targetName) {
    if (!data || !sourceName || !targetName) return;
    if (sourceName.toLowerCase() === targetName.toLowerCase()) return;

    const srcLower = sourceName.toLowerCase();
    const isSource = (n) => typeof n === 'string' && n.toLowerCase() === srcLower;
    const dedupe = (arr) => [...new Set(arr)];

    // 1. Memories: reassign source -> target across every character-bearing field.
    const memories = data[MEMORIES_KEY] || [];
    for (const m of memories) {
        if (Array.isArray(m.characters_involved)) {
            m.characters_involved = dedupe(m.characters_involved.map((n) => (isSource(n) ? targetName : n)));
        }
        if (Array.isArray(m.witnesses)) {
            m.witnesses = dedupe(m.witnesses.map((n) => (isSource(n) ? targetName : n)));
        }
        if (m.emotional_impact && typeof m.emotional_impact === 'object') {
            for (const key of Object.keys(m.emotional_impact)) {
                if (isSource(key)) {
                    // Keep target's existing emotion if it already has one for this event.
                    if (m.emotional_impact[targetName] === undefined) {
                        m.emotional_impact[targetName] = m.emotional_impact[key];
                    }
                    delete m.emotional_impact[key];
                }
            }
        }
        // Reflections carry a singular `character` field in addition to the array.
        if (isSource(m.character)) m.character = targetName;
    }

    // 2. character_states: fold every source-matching entry into the target.
    const states = data[CHARACTERS_KEY];
    if (states) {
        for (const key of Object.keys(states)) {
            if (!isSource(key)) continue;
            const src = states[key];
            const tgt = states[targetName];
            if (!tgt) {
                states[targetName] = { ...src, name: targetName };
            } else {
                tgt.known_events = dedupe([...(tgt.known_events || []), ...(src.known_events || [])]);
                // Newest emotion wins.
                if ((src.last_updated || 0) > (tgt.last_updated || 0)) {
                    tgt.current_emotion = src.current_emotion;
                    tgt.emotion_intensity = src.emotion_intensity;
                    tgt.last_updated = src.last_updated;
                    if (src.emotion_from_messages) tgt.emotion_from_messages = src.emotion_from_messages;
                }
            }
            if (key !== targetName) delete states[key];
        }
    }

    // 3. reflection_state: sum accumulated importance.
    const reflectionState = data.reflection_state;
    if (reflectionState) {
        for (const key of Object.keys(reflectionState)) {
            if (!isSource(key)) continue;
            const src = reflectionState[key];
            const tgt = reflectionState[targetName];
            if (!tgt) {
                reflectionState[targetName] = { ...src };
            } else {
                tgt.importance_sum = (tgt.importance_sum || 0) + (src.importance_sum || 0);
            }
            if (key !== targetName) delete reflectionState[key];
        }
    }
}

/**
 * Merge source entity into target entity. Source is deleted.
 * @param {string} sourceKey - Entity to absorb (will be deleted)
 * @param {string} targetKey - Entity that survives
 * @param {Object} graph - The graph object (defaults to current graph from deps)
 * @returns {Promise<{ success: boolean, stChanges?: { toDelete: { hash: number }[], toSync?: { hash: number, text: string, item: any }[] } }>}
 */
export async function mergeEntities(sourceKey, targetKey, graph = null) {
    const { saveChatConditional } = getDeps();
    const ctx = getDeps().getContext();
    const g = graph || ctx.chatMetadata?.openvault?.graph;

    if (!g) {
        return { success: false };
    }

    // Validation
    if (sourceKey === targetKey) {
        return { success: false };
    }

    const sourceNode = g.nodes[sourceKey];
    const targetNode = g.nodes[targetKey];

    if (!sourceNode || !targetNode) {
        return { success: false };
    }

    // Capture display names before the source node is deleted below — needed to
    // reconcile the name-keyed stores (character_states/reflection_state/memories)
    // for character merges.
    const isCharacterMerge = sourceNode.type === ENTITY_TYPES.PERSON || targetNode.type === ENTITY_TYPES.PERSON;
    const sourceName = sourceNode.name;
    const targetName = targetNode.name;

    const toDelete = [];
    const toSync = [];

    // 1. Combine node data onto target
    targetNode.mentions += sourceNode.mentions;

    // Merge aliases (source name becomes an alias)
    const allAliases = [...(targetNode.aliases || []), ...(sourceNode.aliases || []), sourceNode.name];
    targetNode.aliases = [...new Set(allAliases)];

    // Merge descriptions using segmented Jaccard dedup
    targetNode.description = mergeDescriptions(
        targetNode.description,
        sourceNode.description,
        GRAPH_JACCARD_DUPLICATE_THRESHOLD
    );

    // 2. Set merge redirect and cascade
    if (!g._mergeRedirects) {
        g._mergeRedirects = {};
    }
    g._mergeRedirects[sourceKey] = targetKey;

    // Cascade: update any redirects pointing to source
    for (const [key, value] of Object.entries(g._mergeRedirects)) {
        if (value === sourceKey && key !== sourceKey) {
            g._mergeRedirects[key] = targetKey;
        }
    }

    // 3. Rewrite and combine edges
    const edgesToProcess = Object.entries(g.edges).filter(
        ([_, edge]) => edge.source === sourceKey || edge.target === sourceKey
    );

    for (const [oldKey, edge] of edgesToProcess) {
        const newSource = edge.source === sourceKey ? targetKey : edge.source;
        const newTarget = edge.target === sourceKey ? targetKey : edge.target;
        const newKey = `${newSource}__${newTarget}`;

        // Self-loop check: delete if would be target->target
        if (newSource === newTarget) {
            if (edge._st_synced) {
                toDelete.push({ hash: cyrb53(`[OV_ID:edge_${edge.source}_${edge.target}] ${edge.description}`) });
            }
            delete g.edges[oldKey];
            continue;
        }

        // Collision check: target edge already exists
        if (g.edges[newKey] && newKey !== oldKey) {
            const existingEdge = g.edges[newKey];
            existingEdge.weight += edge.weight;

            // Merge descriptions
            existingEdge.description = mergeDescriptions(
                existingEdge.description,
                edge.description,
                GRAPH_JACCARD_DUPLICATE_THRESHOLD
            );

            // Recalculate tokens using proper token counter
            if (existingEdge._descriptionTokens !== undefined) {
                existingEdge._descriptionTokens = countTokens(existingEdge.description);
            }

            // Check consolidation threshold
            if (existingEdge._descriptionTokens > CONSOLIDATION.TOKEN_THRESHOLD) {
                if (!g._edgesNeedingConsolidation) {
                    g._edgesNeedingConsolidation = [];
                }
                if (!g._edgesNeedingConsolidation.includes(newKey)) {
                    g._edgesNeedingConsolidation.push(newKey);
                }
            }

            // Invalidate embedding since description changed
            deleteEmbedding(existingEdge);

            // Collect hash for old edge deletion
            if (edge._st_synced) {
                toDelete.push({ hash: cyrb53(`[OV_ID:edge_${edge.source}_${edge.target}] ${edge.description}`) });
            }

            // Queue merged edge for re-sync
            const mergedEdgeId = `edge_${newSource}_${newTarget}`;
            const mergedEdgeText = `[OV_ID:${mergedEdgeId}] ${existingEdge.description}`;
            toSync.push({ hash: cyrb53(mergedEdgeText), text: mergedEdgeText, item: existingEdge });

            delete g.edges[oldKey];
        } else if (newKey !== oldKey) {
            // No collision: rewrite edge
            if (edge._st_synced) {
                toDelete.push({ hash: cyrb53(`[OV_ID:edge_${edge.source}_${edge.target}] ${edge.description}`) });
            }
            edge.source = newSource;
            edge.target = newTarget;
            deleteEmbedding(edge);
            g.edges[newKey] = edge;
            delete g.edges[oldKey];

            // Queue rewritten edge for re-sync
            const rewrittenEdgeId = `edge_${newSource}_${newTarget}`;
            const rewrittenEdgeText = `[OV_ID:${rewrittenEdgeId}] ${edge.description}`;
            toSync.push({ hash: cyrb53(rewrittenEdgeText), text: rewrittenEdgeText, item: edge });
        }
    }

    // 4. Cleanup
    // Collect hash for source node deletion
    if (sourceNode._st_synced) {
        toDelete.push({ hash: cyrb53(`[OV_ID:${sourceKey}] ${sourceNode.description}`) });
    }

    delete g.nodes[sourceKey];

    // Invalidate target embedding since description changed
    deleteEmbedding(targetNode);

    // If source or target was synced, queue target for sync
    // (absorbing a synced entity or updating an already-synced one)
    if (sourceNode._st_synced || targetNode._st_synced) {
        const text = `[OV_ID:${targetKey}] ${targetNode.description}`;
        toSync.push({ hash: cyrb53(text), text, item: targetNode });
    }

    // 4b. For character merges, reconcile the display-name-keyed stores the graph
    // merge above doesn't touch (character_states, reflection_state, memory fields).
    if (isCharacterMerge) {
        const data = ctx.chatMetadata?.openvault;
        if (data) reconcileCharacterIdentity(data, sourceName, targetName);
    }

    // 5. Save
    await saveChatConditional();

    return {
        success: true,
        stChanges: { toDelete, toSync },
    };
}

/**
 * Delete a character from character_states.
 * Removes the character and its associated state data (emotions, known events, etc.).
 * @param {string} name - Character name to delete
 * @returns {Promise<boolean>} True if deleted, false otherwise
 */
export async function deleteCharacterFromState(name) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return false;
    }

    const characters = data[CHARACTERS_KEY];
    if (!characters || !characters[name]) {
        logDebug(`Character "${name}" not found in character_states`);
        return false;
    }

    delete characters[name];
    await getDeps().saveChatConditional();
    logDebug(`Deleted character "${name}" from character_states`);
    return true;
}
