// @ts-check

/**
 * OpenVault Reranker Client
 *
 * Calls an external reranker API (e.g., Jina, Cohere, or any OpenAI-compatible
 * reranker) to re-order scored memories by relevance to the query.
 *
 * This runs AFTER the initial scoring pipeline (forgetfulness + BM25 + vector)
 * as an optional second-pass refinement.
 */

import { getSettings } from '../settings.js';
import { logDebug, logWarn } from '../utils/logging.js';

/** @typedef {import('../types').ScoredMemory} ScoredMemory */

/**
 * Call the reranker API with a query and document strings.
 * Returns an array of { index, score } objects sorted by relevance (descending).
 *
 * @param {string} query - The search query
 * @param {string[]} documents - Document strings to rank
 * @param {number} [topN] - Max results to return (default: all)
 * @returns {Promise<{index: number, score: number}[]>} Ranked results
 */
async function callRerankerAPI(query, documents, topN) {
    const settings = getSettings();
    const url = String(settings.rerankerApiUrl || '').trim();
    const apiKey = String(settings.rerankerApiKey || '').trim();
    const model = String(settings.rerankerModel || '').trim();

    if (!url) {
        throw new Error('Reranker API URL not configured');
    }

    // Normalize URL: append /rerank if not already present
    const normalizedUrl = url.endsWith('/rerank') ? url : url.replace(/\/+$/, '') + '/rerank';

    const requestBody = {
        query,
        documents,
        // Jina and Cohere both use `top_n`; most OpenAI-compatible rerankers accept it too.
        top_n: topN || documents.length,
    };

    // Include model if specified (required by some providers like Cohere)
    if (model) {
        requestBody.model = model;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(normalizedUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Reranker API HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`);
    }

    const payload = await response.json();

    // Parse results - handle multiple API response formats
    return extractRankedResults(payload, documents.length);
}

/**
 * Extract ranked results from various reranker API response formats.
 * Supports: Jina, Cohere, generic OpenAI-compatible.
 *
 * @param {Object} payload - API response JSON
 * @param {number} expectedLength - Expected number of results
 * @returns {{index: number, score: number}[]}
 */
function extractRankedResults(payload, expectedLength) {
    // Format 1: { results: [{ index, relevance_score }] } (Jina, Cohere)
    const entries = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.data)
          ? payload.data
          : [];

    if (entries.length > 0) {
        return entries
            .map((entry, fallbackIdx) => {
                const score = resolveScore(entry);
                const index = resolveIndex(entry, fallbackIdx, expectedLength);
                return index >= 0 ? { index, score } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
    }

    // Format 2: { scores: [0.9, 0.3, ...] } (simple score array)
    if (Array.isArray(payload?.scores)) {
        return payload.scores
            .map((score, index) => ({ index, score: toScore(score) || 0 }))
            .sort((a, b) => b.score - a.score);
    }

    return [];
}

/**
 * Resolve score from a result entry, checking multiple field names.
 * @param {Object} entry
 * @returns {number}
 */
function resolveScore(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    return (
        toScore(entry.score ?? entry.relevance_score ?? entry.relevanceScore ?? entry.similarity ?? entry.value) || 0
    );
}

/**
 * Resolve document index from a result entry.
 * @param {Object} entry
 * @param {number} fallbackIndex
 * @param {number} maxLength
 * @returns {number}
 */
function resolveIndex(entry, fallbackIndex, maxLength) {
    const candidates = [entry?.index, entry?.idx, entry?.documentIndex, entry?.document_index, entry?.position];

    for (const candidate of candidates) {
        const idx = Number(candidate);
        if (Number.isInteger(idx) && idx >= 0 && idx < maxLength) {
            return idx;
        }
    }

    if (Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < maxLength) {
        return fallbackIndex;
    }

    return -1;
}

/**
 * Safely parse a numeric score value.
 * @param {*} value
 * @returns {number|null}
 */
function toScore(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Test reranker connectivity with a minimal request.
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testRerankerConnection() {
    const settings = getSettings();
    const url = String(settings.rerankerApiUrl || '').trim();

    if (!url) {
        return { success: false, message: 'Reranker API URL not configured' };
    }

    try {
        const results = await callRerankerAPI('connection test', ['alpha', 'beta'], 2);
        return {
            success: results.length > 0,
            message:
                results.length > 0
                    ? `Connected (${results.length} results returned)`
                    : 'No results returned from reranker',
        };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

/**
 * Rerank scored memories using an external reranker API.
 *
 * Takes the top-scored memories, sends their summaries to the reranker,
 * then re-orders the list based on reranker relevance scores. Memories the
 * reranker doesn't return (and any beyond the reranked window) are appended
 * afterwards in their original score order. Each memory's reranker score is
 * attached as `_rerankerScore` for debug/diagnostics.
 *
 * @param {ScoredMemory[]} scoredMemories - Scored memories (already sorted by score)
 * @param {string} query - The user's query text
 * @param {number} [maxDocuments] - Maximum documents to send to reranker (default: 50)
 * @returns {Promise<{results: ScoredMemory[], meta: {documentsSent: number, rerankerUsed: boolean, error?: string}}>}
 */
export async function rerankScoredMemories(scoredMemories, query, maxDocuments) {
    const settings = getSettings();
    const enabled = settings.rerankerEnabled === true;
    const effectiveMaxDocs = maxDocuments || settings.rerankerMaxDocuments || 50;
    const topN = settings.rerankerTopN || 20;

    const meta = {
        documentsSent: 0,
        rerankerUsed: false,
        error: undefined,
    };

    // Guard: disabled, no query, or too few results
    if (!enabled || !query || !scoredMemories || scoredMemories.length <= 1) {
        return { results: scoredMemories, meta };
    }

    // Only rerank the top N to avoid excessive API costs
    const candidates = scoredMemories.slice(0, effectiveMaxDocs);
    const documents = candidates.map((r) => r.memory.summary || '');

    // Skip if no valid documents
    if (documents.every((d) => !d.trim())) {
        return { results: scoredMemories, meta };
    }

    meta.documentsSent = candidates.length;

    try {
        const ranked = await callRerankerAPI(query, documents, topN);

        if (ranked.length === 0) {
            logDebug('Reranker returned no results, using original order');
            return { results: scoredMemories, meta };
        }

        // Build a re-ordered array based on reranker results
        const rerankedSet = new Set();
        const reranked = [];

        // First: add memories in reranker order
        for (const { index, score } of ranked) {
            if (index >= 0 && index < candidates.length) {
                const sm = candidates[index];
                // Store reranker score for debug
                sm._rerankerScore = score;
                reranked.push(sm);
                rerankedSet.add(index);
            }
        }

        // Append any memories not returned by the reranker (preserve original order)
        for (let i = 0; i < candidates.length; i++) {
            if (!rerankedSet.has(i)) {
                reranked.push(candidates[i]);
            }
        }

        // Append remaining memories beyond the reranked window
        if (scoredMemories.length > effectiveMaxDocs) {
            reranked.push(...scoredMemories.slice(effectiveMaxDocs));
        }

        meta.rerankerUsed = true;
        logDebug(`Reranker: ${candidates.length} candidates -> ${ranked.length} ranked`);

        return { results: reranked, meta };
    } catch (err) {
        logWarn(`Reranker failed: ${err.message}`);
        meta.error = err.message;
        // Graceful fallback: return original order
        return { results: scoredMemories, meta };
    }
}
