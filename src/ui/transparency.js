/**
 * OpenVault Transparency Module
 *
 * Tracks extraction and injection activity so users can see exactly what
 * the extension is doing. Provides enhanced notifications, a "recent" filter,
 * and an injection preview.
 */

import { getDeps } from '../deps.js';
import { escapeHtml, showToast } from '../utils/dom.js';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {{ timestamp: number, summaries: string[], eventsCreated: number, messagesProcessed: number }|null} */
let lastExtraction = null;

/** @type {{ timestamp: number, memoryCount: number, memories: {id: string, summary: string, type: string, importance: number, characters_involved: string[]}[] }|null} */
let lastInjection = null;

/** Timestamp when the side panel was last refreshed — used for "recent" filter */
let sessionStartTime = Date.now();

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Record an extraction result and show an enhanced notification.
 * Called after each extraction batch completes.
 * @param {{ status: string, events_created?: number, messages_processed?: number, event_summaries?: string[] }} result
 */
export function recordExtraction(result) {
    if (result.status !== 'success' || !result.events_created) return;

    lastExtraction = {
        timestamp: Date.now(),
        summaries: result.event_summaries || [],
        eventsCreated: result.events_created,
        messagesProcessed: result.messages_processed || 0,
    };

    showExtractionNotification(lastExtraction);
}

/**
 * Record an injection (retrieval) result.
 * Called after each pre-generation retrieval.
 * @param {{ id: string, summary: string, type: string, importance: number, characters_involved: string[] }[]} memories
 */
export function recordInjection(memories) {
    lastInjection = {
        timestamp: Date.now(),
        memoryCount: memories.length,
        memories: memories.map((m) => ({
            id: m.id,
            summary: m.summary || '',
            type: m.type || 'event',
            importance: m.importance || 3,
            characters_involved: m.characters_involved || [],
        })),
    };
    updateInjectionStatusBadge();
}

/**
 * Get the last extraction record.
 * @returns {typeof lastExtraction}
 */
export function getLastExtraction() {
    return lastExtraction;
}

/**
 * Get the last injection record.
 * @returns {typeof lastInjection}
 */
export function getLastInjection() {
    return lastInjection;
}

/**
 * Get the session start time (used for "recent" filter).
 * @returns {number}
 */
export function getSessionStartTime() {
    return sessionStartTime;
}

/**
 * Reset session start time (call on chat change).
 */
export function resetSessionStartTime() {
    sessionStartTime = Date.now();
    lastExtraction = null;
    lastInjection = null;
}

// ── Notifications ────────────────────────────────────────────────────────────

/**
 * Show an enhanced extraction notification with event summaries.
 * Falls back to a simple toast if the custom popup can't be shown.
 * @param {typeof lastExtraction} extraction
 */
function showExtractionNotification(extraction) {
    if (!extraction || extraction.summaries.length === 0) return;

    const count = extraction.eventsCreated;
    const maxPreview = 3;
    const previews = extraction.summaries.slice(0, maxPreview);
    const remaining = count - previews.length;

    // Build the notification body
    let bodyHtml = '<div class="openvault-extraction-notify">';
    bodyHtml += `<div class="openvault-extraction-notify-header">Extracted ${count} memor${count === 1 ? 'y' : 'ies'} from ${extraction.messagesProcessed} message${extraction.messagesProcessed === 1 ? '' : 's'}</div>`;
    bodyHtml += '<ul class="openvault-extraction-notify-list">';
    for (const summary of previews) {
        bodyHtml += `<li>${escapeHtml(truncate(summary, 80))}</li>`;
    }
    if (remaining > 0) {
        bodyHtml += `<li class="openvault-extraction-notify-more">…and ${remaining} more</li>`;
    }
    bodyHtml += '</ul>';
    bodyHtml +=
        '<button class="openvault-extraction-notify-view" onclick="document.dispatchEvent(new CustomEvent(\'openvault:view-recent\'))">View in Panel</button>';
    bodyHtml += '</div>';

    // Try to show via toastr with extended time and HTML
    try {
        const deps = getDeps();
        const toastr = deps.getContext()?.toastr;
        if (toastr) {
            toastr.info(bodyHtml, 'OpenVault Extraction', {
                timeOut: 8000,
                extendedTimeOut: 4000,
                escapeHtml: false,
                positionClass: 'toast-top-right',
                onclick: () => {
                    document.dispatchEvent(new CustomEvent('openvault:view-recent'));
                },
            });
            return;
        }
    } catch (_e) {
        // Fall through to simple toast
    }

    // Fallback: simple toast
    showToast('success', `Extracted ${count} memor${count === 1 ? 'y' : 'ies'}`);
}

// ── Injection Status Badge ───────────────────────────────────────────────────

/**
 * Update the status badge to show last injection info.
 */
function updateInjectionStatusBadge() {
    const $badge = $('#openvault_injection_badge');
    if (!lastInjection || lastInjection.memoryCount === 0) {
        $badge.text('');
        return;
    }

    const ago = formatTimeAgo(lastInjection.timestamp);
    $badge.text(`${lastInjection.memoryCount} injected ${ago}`);
}

// ── Injection Preview Rendering ──────────────────────────────────────────────

/**
 * Render the injection preview tab content.
 * @param {jQuery} $container - Container element to render into
 */
export function renderInjectionPreview($container) {
    if (!lastInjection) {
        $container.html(`
            <div class="openvault-injection-preview-empty">
                <i class="fa-solid fa-circle-info"></i>
                <p>No injection yet. Injection happens automatically before each LLM generation.</p>
            </div>
        `);
        return;
    }

    const ago = formatTimeAgo(lastInjection.timestamp);
    let html = `<div class="openvault-injection-preview-header">`;
    html += `<span class="openvault-injection-preview-count">${lastInjection.memoryCount} memor${lastInjection.memoryCount === 1 ? 'y' : 'ies'}</span>`;
    html += `<span class="openvault-injection-preview-time">injected ${ago}</span>`;
    html += `</div>`;

    if (lastInjection.memories.length === 0) {
        html += `<div class="openvault-injection-preview-empty"><p>No memories were injected into the last generation.</p></div>`;
    } else {
        html += '<div class="openvault-injection-preview-list">';
        for (const mem of lastInjection.memories) {
            const typeIcon = mem.type === 'reflection' ? 'fa-lightbulb' : 'fa-bookmark';
            const importanceClass = mem.importance >= 7 ? 'high' : mem.importance >= 4 ? 'medium' : 'low';
            html += `<div class="openvault-injection-preview-item" data-id="${escapeHtml(mem.id)}">`;
            html += `<div class="openvault-injection-preview-item-header">`;
            html += `<i class="fa-solid ${typeIcon}"></i>`;
            html += `<span class="openvault-injection-preview-importance ${importanceClass}">★${mem.importance}</span>`;
            html += `</div>`;
            html += `<div class="openvault-injection-preview-summary">${escapeHtml(mem.summary)}</div>`;
            if (mem.characters_involved.length > 0) {
                html += `<div class="openvault-injection-preview-chars">`;
                for (const char of mem.characters_involved) {
                    html += `<span class="openvault-injection-preview-char">${escapeHtml(char)}</span>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }
        html += '</div>';
    }

    $container.html(html);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate a string to maxLength, adding ellipsis if needed.
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(str, maxLength) {
    if (!str) return '';
    return str.length > maxLength ? str.substring(0, maxLength) + '…' : str;
}

/**
 * Format a timestamp as a human-readable "time ago" string.
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}
