/**
 * Stub for SillyTavern's regex/engine.js
 * Used by vitest tests to resolve the dynamic import in src/utils/message-sanitizer.js.
 *
 * The real engine applies user-configured regex scripts to chat messages.
 * In tests we only need the surface API to exist so the import resolves;
 * the sanitizer is expected to no-op gracefully when the engine is absent,
 * and these stubs mirror that pass-through behavior.
 */

export const regex_placement = {
    USER_INPUT: 0,
    AI_OUTPUT: 1,
    SLASH_COMMAND: 2,
    DESCRIPTION: 3,
    PERSONA_DESCRIPTION: 4,
    SCENARIO: 5,
    CHARACTER_DEPTH: 6,
};

export function getRegexedString(value, _placement, _options) {
    return value;
}

export function getRegexScripts() {
    return [];
}
