/**
 * OpenVault LLM Service
 *
 * Unified LLM communication for extraction and retrieval operations.
 * Prompts must be arrays of message objects with System/User roles.
 */

// @ts-check

import { defaultSettings, extensionName } from './constants.js';
import { getDeps } from './deps.js';
import {
    getCommunitySummaryJsonSchema,
    getContradictionVerificationJsonSchema,
    getEdgeConsolidationJsonSchema,
    getEventExtractionJsonSchema,
    getGraphExtractionJsonSchema,
    getUnifiedReflectionJsonSchema,
} from './extraction/structured.js';
import { getSettings } from './settings.js';
import { getSessionSignal, setLastApiCallTime } from './state.js';
import { showToast } from './utils/dom.js';
import { logDebug, logError, logRequest } from './utils/logging.js';
import { withTimeout } from './utils/st-helpers.js';

/** @typedef {import('./types.d.ts').LLMConfig} LLMConfig */
/** @typedef {import('./types.d.ts').LLMCallOptions} LLMCallOptions */
/** @typedef {import('./types.d.ts').LLMMessages} LLMMessages */

/**
 * Race a promise against an AbortSignal.
 * @template T
 * @param {Promise<T>} promise - The promise to race
 * @param {AbortSignal} signal - The signal to watch
 * @returns {Promise<T>} Resolves/rejects with the first to settle
 */
function raceAbort(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            }
        );
    });
}

/**
 * LLM configuration presets
 */
export const LLM_CONFIGS = {
    extraction_events: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 8000,
        errorContext: 'Event Extraction',
        timeoutMs: 240000,
        getJsonSchema: getEventExtractionJsonSchema,
    },
    extraction_graph: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 16000,
        errorContext: 'Graph Extraction',
        timeoutMs: 180000,
        getJsonSchema: getGraphExtractionJsonSchema,
    },
    reflection: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 8000,
        errorContext: 'Unified Reflection',
        timeoutMs: 180000,
        getJsonSchema: getUnifiedReflectionJsonSchema,
    },
    community: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 8000,
        errorContext: 'Community summarization',
        timeoutMs: 180000,
        getJsonSchema: getCommunitySummaryJsonSchema,
    },
    edge_consolidation: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 400,
        errorContext: 'Edge consolidation',
        timeoutMs: 60000,
        getJsonSchema: getEdgeConsolidationJsonSchema,
    },
    contradiction: {
        profileSettingKey: 'extractionProfile',
        maxTokens: 500,
        errorContext: 'Contradiction verification',
        timeoutMs: 60000,
        getJsonSchema: getContradictionVerificationJsonSchema,
    },
};

/**
 * Check if an error is transient (retryable) — 5xx server errors, network failures, etc.
 * Does NOT retry 4xx (client errors) or timeouts (they'd likely fail again immediately).
 * @param {Error} error - The error to check
 * @returns {boolean}
 */
function isTransientError(error) {
    const msg = (error.message || '').toLowerCase();
    // 5xx server errors
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
    // Network errors
    if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('enotfound')) return true;
    // Rate limit (429) — retryable after backoff
    if (msg.includes('429') || msg.includes('rate limit')) return true;
    return false;
}

/**
 * Retry a function with exponential backoff for transient errors.
 * @template T
 * @param {() => Promise<T>} fn - The function to retry
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} baseDelayMs - Base delay in ms (doubles each retry)
 * @param {string} errorContext - Label for logging
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxRetries = 2, baseDelayMs = 1500, errorContext = 'LLM') {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            // Don't retry AbortErrors (user cancelled)
            if (error.name === 'AbortError') throw error;
            // Don't retry if not transient or if this was the last attempt
            if (!isTransientError(error) || attempt >= maxRetries) throw error;

            const delay = baseDelayMs * Math.pow(2, attempt);
            logDebug(`${errorContext}: transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${error.message}`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError;
}

/**
 * Call LLM with messages array
 * @param {LLMMessages} messages - Array of message objects
 * @param {LLMConfig} config - Request configuration from LLM_CONFIGS
 * @param {LLMCallOptions} [options] - Optional parameters
 * @returns {Promise<string>} The LLM response content
 * @throws {Error} If the LLM call fails or no profile is available
 */
export async function callLLM(messages, config, options = {}) {
    const { profileSettingKey, maxTokens, errorContext, timeoutMs, getJsonSchema } = config;
    const signal = options.signal ?? getSessionSignal();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const deps = getDeps();
    const extension_settings = deps.getExtensionSettings();
    const settings = extension_settings[extensionName];

    // Get profile ID - use specified profile or fall back to currently selected
    let profileId = options.profileId ?? settings[profileSettingKey];

    if (!profileId) {
        profileId = extension_settings?.connectionManager?.selectedProfile;
        if (profileId) {
            const profiles = extension_settings?.connectionManager?.profiles || [];
            const profile = profiles.find((p) => p.id === profileId);
            logDebug(`No ${profileSettingKey} set, using current profile: ${profile?.name || profileId}`);
        }
    }

    if (!profileId) {
        throw new Error(
            `No connection profile available for ${errorContext.toLowerCase()}. Please configure a profile in Connection Manager.`
        );
    }

    // --- Helper: execute a single LLM request against a given profile ---
    async function executeRequest(targetProfileId) {
        const requestPromise = deps.connectionManager.sendRequest(
            targetProfileId,
            messages,
            maxTokens,
            {
                includePreset: true,
                includeInstruct: true,
                stream: false,
            },
            jsonSchema ? { jsonSchema } : {}
        );

        const result = await raceAbort(withTimeout(requestPromise, timeoutMs || 120000, `${errorContext} API`), signal);
        setLastApiCallTime(Date.now());

        // Extract content from result object.
        let content = result && typeof result === 'object' && 'content' in result ? result.content : result || '';

        // Reasoning models (DeepSeek, Kimi, etc.) may return the actual output in
        // the `reasoning` field while leaving `content` empty. Try to recover:
        // 1. Look for a JSON object/array in the reasoning text (structured calls)
        // 2. Fall back to the full reasoning text (unstructured calls)
        if (!content && result && typeof result === 'object' && result.reasoning) {
            logDebug(`Content empty but reasoning field has ${result.reasoning.length} chars — attempting recovery`);

            const jsonMatch = result.reasoning.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
            if (jsonMatch) {
                logDebug('Recovered JSON block from end of reasoning field');
                content = jsonMatch[1];
            } else {
                content = result.reasoning;
            }
        }

        logDebug(`LLM response received (${content.length} chars)`);
        logRequest(errorContext, { messages, maxTokens, profileId: targetProfileId, response: content });

        if (!content) {
            logDebug(`ERROR: Empty LLM response! Full result: ${JSON.stringify(result).substring(0, 200)}`);
            throw new Error('Empty response from LLM');
        }

        const context = deps.getContext();
        if (context.parseReasoningFromString) {
            const parsed = context.parseReasoningFromString(content);
            return parsed ? parsed.content : content;
        }

        return content;
    }

    const jsonSchema = options.structured && getJsonSchema ? getJsonSchema() : undefined;

    // --- Main request with retry + backup failover ---
    try {
        logDebug(`Using ConnectionManagerRequestService with profile: ${profileId}`);
        return await withRetry(
            () => executeRequest(profileId),
            2,    // maxRetries
            1500, // baseDelayMs
            errorContext
        );
    } catch (mainError) {
        setLastApiCallTime(Date.now());
        if (mainError.name === 'AbortError') throw mainError;

        // Attempt backup profile if configured and different from main
        const backupProfileId = options.backupProfileId ?? settings.backupProfile;
        if (backupProfileId && backupProfileId !== profileId) {
            const profiles = extension_settings?.connectionManager?.profiles || [];
            const backupName = profiles.find((p) => p.id === backupProfileId)?.name || backupProfileId;
            logDebug(`${errorContext} failed on main profile, trying backup: ${backupName}`);
            try {
                const backupResult = await withRetry(
                    () => executeRequest(backupProfileId),
                    1,    // maxRetries (fewer for backup)
                    2000, // baseDelayMs
                    `${errorContext} backup`
                );
                return backupResult;
            } catch (backupError) {
                logDebug(`${errorContext} backup also failed: ${backupError.message}`);
            }
        }

        // Original error handling — toast + re-throw main error
        const errorMessage = mainError.message || 'Unknown error';
        logError(`${errorContext} LLM call failed`, mainError, {
            profileId,
            maxTokens,
        });
        if (!errorMessage.includes('timed out')) {
            showToast('error', `${errorContext} failed: ${errorMessage}`);
        }
        logRequest(errorContext, { messages, maxTokens, profileId, error: mainError });
        throw mainError;
    }
}

/**
 * Call an OpenAI-compatible chat completions API directly (outside Connection Manager).
 *
 * Designed for features that benefit from a separate, user-configurable endpoint —
 * e.g., running contradiction analysis on a local 16B model while the main extraction
 * uses a large cloud API.
 *
 * @param {LLMMessages} messages - Array of message objects [{role, content}]
 * @param {Object} options
 * @param {string} options.apiUrl - Base URL (e.g., "http://localhost:11434/v1")
 * @param {string} [options.apiKey] - Bearer token (optional for local servers)
 * @param {string} options.model - Model name (e.g., "qwen2.5:16b")
 * @param {number} [options.maxTokens=500] - Max completion tokens
 * @param {number} [options.timeoutMs=60000] - Request timeout
 * @param {string} [options.errorContext='OpenAI-Compatible API'] - Label for error messages
 * @returns {Promise<string>} The response content string
 */
export async function callOpenAICompat(messages, options) {
    const {
        apiUrl,
        apiKey,
        model,
        maxTokens = 500,
        timeoutMs = 60000,
        errorContext = 'OpenAI-Compatible API',
    } = options;

    if (!apiUrl) throw new Error(`${errorContext}: API URL not configured`);
    if (!model) throw new Error(`${errorContext}: Model name not configured`);

    // Normalize URL: ensure it ends with /chat/completions
    const baseUrl = apiUrl.replace(/\/+$/, '');
    const endpoint = baseUrl.endsWith('/chat/completions')
        ? baseUrl
        : baseUrl.endsWith('/v1')
          ? `${baseUrl}/chat/completions`
          : `${baseUrl}/v1/chat/completions`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
        model,
        messages,
        max_completion_tokens: maxTokens,
        temperature: 0.1,
        stream: false,
    });

    logDebug(`${errorContext}: calling ${endpoint} with model ${model}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(
                `${errorContext} HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`
            );
        }

        const data = await response.json();

        // Extract content from OpenAI-compatible response format
        const content = data?.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error(`${errorContext}: empty response from model`);
        }

        logDebug(`${errorContext}: response received (${content.length} chars)`);
        return content;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`${errorContext}: request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
