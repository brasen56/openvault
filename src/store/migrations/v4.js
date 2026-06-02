import { MEMORIES_KEY } from '../../constants.js';

/**
 * Backfill `extraction_count` on memories that pre-date the monotonic decay axis.
 *
 * Events historically encoded `sequence = minMessageId * 1000 + index`, so
 * `Math.floor(sequence / 1000)` recovers the lowest source message_id at extraction
 * time — a decent proxy for "how far into the chat had we ingested when this memory
 * was born." For reflections, `sequence = Date.now()` so that proxy doesn't apply;
 * we fall back to `graph_message_count` (best-effort: treats them as freshly stamped).
 *
 * Capped at `data.graph_message_count` to prevent future-dated stamps from breaking
 * the invariant `currentExtractionCount >= memory.extraction_count`.
 *
 * @param {Object} data - OpenVault data (mutated)
 * @returns {boolean} True if any memories were backfilled
 */
function backfillExtractionCount(data) {
    const memories = data[MEMORIES_KEY];
    if (!memories?.length) return false;

    const graphCount = data.graph_message_count || 0;
    let changed = false;

    for (const memory of memories) {
        if (typeof memory.extraction_count === 'number') continue;

        let candidate;
        if (memory.type === 'reflection') {
            // Reflections used Date.now() for sequence — not message-derived.
            // Stamp them as "as old as the corpus" so they decay from now on.
            candidate = graphCount;
        } else if (typeof memory.sequence === 'number') {
            candidate = Math.floor(memory.sequence / 1000);
        } else if (memory.message_ids?.length) {
            candidate = Math.max(...memory.message_ids);
        } else {
            candidate = 0;
        }

        // Clamp to [0, graphCount] — never future-stamp.
        // When graphCount is 0 (unseeded data), fall through with the candidate value
        // so memories still get *some* anchor; once the counter starts moving they decay.
        memory.extraction_count = graphCount > 0
            ? Math.min(Math.max(0, candidate), graphCount)
            : Math.max(0, candidate);
        changed = true;
    }

    return changed;
}

/**
 * Run full v4 migration.
 * @param {Object} data - OpenVault data (mutated)
 * @param {Array} _chat - Chat messages (unused; signature kept for migration runner)
 * @returns {boolean} True if any changes made
 */
export function migrateToV4(data, _chat) {
    return backfillExtractionCount(data);
}
