/**
 * Vitest setup file
 * Runs before all tests to configure the test environment.
 */

// Mock scheduler API (browser-only, not available in Node/vitest)
global.scheduler = {
    yield: () => Promise.resolve(),
};

// Mock fetch API globally for tests that need it
global.fetch = vi.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
    })
);

// Minimal jQuery mock for tests.
// Returns a chainable stub object for any $(...) call. Getter-style methods
// (.val(), .text(), .is(), .hasClass(), .attr(), .prop(), .data()) return safe
// defaults; mutator/traversal methods return the chain so calls compose.
global.$ = (selector) => {
    const chain = () => global.$(selector);
    return {
        on: chain,
        one: chain,
        off: chain,
        trigger: chain,
        val: () => '',
        prop: () => false,
        text: (v) => (v === undefined ? '' : chain()),
        html: (v) => (v === undefined ? '' : chain()),
        is: () => false,
        hasClass: () => false,
        attr: () => '',
        removeAttr: chain,
        removeProp: chain,
        data: () => ({}),
        append: chain,
        appendTo: chain,
        prepend: chain,
        after: chain,
        before: chain,
        remove: chain,
        detach: chain,
        empty: chain,
        replaceWith: chain,
        addClass: chain,
        removeClass: chain,
        toggleClass: chain,
        css: chain,
        show: chain,
        hide: chain,
        toggle: chain,
        fadeIn: chain,
        fadeOut: chain,
        fadeTo: chain,
        slideDown: chain,
        slideUp: chain,
        focus: chain,
        blur: chain,
        find: chain,
        filter: chain,
        parent: chain,
        parents: chain,
        closest: chain,
        children: chain,
        siblings: chain,
        next: chain,
        prev: chain,
        each: chain,
        map: chain,
        length: 0,
        0: undefined,
    };
};

global.toastr = {
    info: () => ({ remove: () => {} }),
    success: () => ({}),
    warning: () => ({}),
    error: () => ({}),
};

import { defaultSettings, extensionName } from '../src/constants.js';
// ── Shared test context helper ──
import { setDeps } from '../src/deps.js';

// ── CDN import overrides: local packages instead of network fetches ──
// Must run BEFORE source modules are imported (top-level await in setupFiles).
import { _setTestOverride } from '../src/utils/cdn.js';

const CDN_SPECS = {
    zod: () => import('zod'),
    jsonrepair: () => import('jsonrepair'),
    'snowball-stemmers': () => import('snowball-stemmers'),
    stopword: () => import('stopword'),
    graphology: () => import('graphology'),
    'graphology-communities-louvain': () => import('graphology-communities-louvain'),
    'graphology-operators': () => import('graphology-operators'),
    'gpt-tokenizer/encoding/o200k_base': () => import('gpt-tokenizer/encoding/o200k_base'),
    'p-queue': () => import('p-queue'),
    'cyrillic-to-translit-js': () => import('cyrillic-to-translit-js'),
};

// Initial registration (setup.js module instance of cdn.js)
for (const [spec, loader] of Object.entries(CDN_SPECS)) {
    _setTestOverride(spec, await loader());
}

/**
 * Re-register CDN overrides on a fresh cdn.js instance.
 * Call from tests that use vi.resetModules().
 */
global.registerCdnOverrides = async () => {
    const { _setTestOverride: setOverride } = await import('../src/utils/cdn.js');
    for (const [spec, loader] of Object.entries(CDN_SPECS)) {
        setOverride(spec, await loader());
    }
};

/**
 * Standard test context setup. Replaces per-file setDeps boilerplate.
 *
 * @param {Object} [overrides]
 * @param {Object} [overrides.context]  - Merged into getContext() return
 * @param {Object} [overrides.settings] - Merged into openvault extension settings
 * @param {Object} [overrides.deps]     - Merged directly into deps (Date, saveChatConditional, etc.)
 */
global.setupTestContext = (overrides = {}) => {
    setDeps({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getContext: () => ({
            chat: [],
            name1: 'User',
            name2: 'Alice',
            chatId: 'test-chat-123',
            chatMetadata: { openvault: {} },
            registerMacro: () => {}, // Mock for macro registration
            ...overrides.context,
        }),
        getExtensionSettings: () => ({
            [extensionName]: {
                ...defaultSettings,
                enabled: true,
                debugMode: false,
                ...overrides.settings,
            },
        }),
        Date: { now: () => 1000000 },
        ...overrides.deps,
    });
};
