/**
 * Unified reflection prompt builder.
 */

/** @typedef {import('../../types.d.ts').ReflectionPromptParams} ReflectionPromptParams */
/** @typedef {import('../../types.d.ts').LLMMessages} LLMMessages */
/** @typedef {import('../../types.d.ts').Memory} Memory */

import {
    assembleSystemPrompt,
    assembleUserConstraints,
    buildMessages,
    resolveLanguageInstruction,
} from '../shared/formatters.js';
import { getExamples } from './examples/index.js';
import { UNIFIED_REFLECTION_ROLE } from './role.js';
import { UNIFIED_REFLECTION_RULES } from './rules.js';
import { UNIFIED_REFLECTION_SCHEMA } from './schema.js';

/**
 * Format existing reflections as a dedicated context section.
 * @param {Memory[]} existingReflections - Previous reflections for the character
 * @returns {string} Formatted XML section, or empty string if none
 */
function formatExistingReflections(existingReflections) {
    if (!Array.isArray(existingReflections) || existingReflections.length === 0) return '';
    const lines = existingReflections
        .map((r) => {
            const stars = '★'.repeat(r.importance || 3);
            return `- [${stars}] [L${r.level || 1}] ${r.summary}`;
        })
        .join('\n');
    return `<existing_reflections>\nPrevious insights already established for this character (avoid repeating these — build on them or identify contradictions):\n${lines}\n</existing_reflections>`;
}

/**
 * Format canon notes (authoritative corrections from the Phase 3 correction
 * loop) as a hard negative-constraint section. These OVERRIDE any pattern the
 * model might infer from memories and pair with the grounding rule in rules.js.
 * Empty / blank input yields no section.
 * @param {Array<{text?: string}>} canonNotes
 * @returns {string}
 */
function formatCanonNotes(canonNotes) {
    if (!Array.isArray(canonNotes) || canonNotes.length === 0) return '';
    const lines = canonNotes
        .map((n) => (n.text || '').trim())
        .filter((text) => text.length > 0)
        .map((text) => `- ${text}`)
        .join('\n');
    if (!lines) return '';
    return `<canon_notes>\nAuthoritative corrections for this character. These OVERRIDE any pattern you might infer from the memories — never generate an insight that contradicts them, and do not soften them into "sometimes" or "tends to":\n${lines}\n</canon_notes>`;
}

/**
 * Build the unified reflection prompt.
 * @param {string} characterName - Character name to reflect on
 * @param {Memory[]} recentMemories - Recent memories (events + reflections candidate set)
 * @param {Memory[]} existingReflections - Previous reflections for context (separate from candidates)
 * @param {string} characterDescription - Character card description for grounding
 * @param {string} preamble - System prompt preamble
 * @param {'auto'|'en'|'ru'} [outputLanguage] - Output language
 * @param {string} prefill - Assistant prefill text (required)
 * @param {Array<{id: string, text: string}>} [canonNotes] - Authoritative corrections injected as a hard negative constraint (Phase 3 correction loop)
 * @returns {LLMMessages} Array of {role, content} message objects
 */
export function buildUnifiedReflectionPrompt(
    characterName,
    recentMemories,
    existingReflections,
    characterDescription,
    preamble,
    outputLanguage = 'auto',
    // @ts-expect-error - TS1016: flat param list with default before required param is TS limitation
    prefill,
    canonNotes = []
) {
    const hasOldReflections = recentMemories.some((m) => m.type === 'reflection' && (m.level || 1) >= 1);

    const memoryList = recentMemories
        .map((m) => {
            const importance = '★'.repeat(m.importance || 3);
            const levelIndicator = m.type === 'reflection' ? ` [Ref L${m.level || 1}]` : '';
            return `${m.id}. [${importance}]${levelIndicator} ${m.summary}`;
        })
        .join('\n');

    const rules = hasOldReflections
        ? UNIFIED_REFLECTION_RULES +
          '\n\nLEVEL-AWARE SYNTHESIS:\n' +
          '7. Some candidate memories are existing reflections (marked [Ref L1], [Ref L2], etc.).\n' +
          '8. You may synthesize multiple existing reflections into higher-level insights (Level 2+).\n' +
          '9. Level 2 reflections should distill common patterns across multiple Level 1 reflections.\n' +
          '10. When synthesizing reflections, cite the reflection IDs as evidence_ids.'
        : UNIFIED_REFLECTION_RULES;

    const systemPrompt = assembleSystemPrompt({
        role: UNIFIED_REFLECTION_ROLE,
        examples: getExamples('REFLECTIONS', outputLanguage),
        outputLanguage,
    });

    const languageInstruction = resolveLanguageInstruction(memoryList, outputLanguage);

    const levelAwareInstruction = hasOldReflections
        ? `\nLEVEL-AWARE SYNTHESIS MODE:\nSome memories are existing reflections (marked [Ref L1], [Ref L2]). You may synthesize them into higher-level meta-insights.\n- Level 2 insights should distill common patterns across multiple Level 1 reflections.\n- When synthesizing reflections, cite the reflection IDs as evidence_ids.\n`
        : '';

    const constraints = assembleUserConstraints({
        rules,
        schema: UNIFIED_REFLECTION_SCHEMA,
        languageInstruction,
    });

    // Build context sections
    const charSection = characterDescription
        ? `<character_description>\n${characterDescription}\n</character_description>\n\n`
        : '';
    const canonSection = formatCanonNotes(canonNotes);
    const reflectionSection = formatExistingReflections(existingReflections);
    const reflectionBlock = reflectionSection ? `\n\n${reflectionSection}` : '';

    const userPrompt = `<character>${characterName}</character>

${charSection}${canonSection ? `${canonSection}\n\n` : ''}<recent_memories>
${memoryList}
</recent_memories>${reflectionBlock}

Based on these memories about ${characterName}:
1. Generate 1-3 salient high-level questions about their current psychological state, relationships, goals, or unresolved conflicts.
2. For each question, provide a deep insight that synthesizes patterns across the memories.
3. Rate each insight's importance (1-5) based on how durable and significant it is for understanding the character.
4. Cite specific memory IDs as evidence for each insight. You MUST use IDs exactly as shown above.
${levelAwareInstruction}
${constraints}`;

    return buildMessages(systemPrompt, userPrompt, prefill || '', preamble);
}
