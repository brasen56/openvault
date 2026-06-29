/**
 * Event extraction prompt builder (Stage A).
 */

/** @typedef {import('../../types.d.ts').BasePromptParams} BasePromptParams */
/** @typedef {import('../../types.d.ts').LLMMessages} LLMMessages */
/** @typedef {import('../../types.d.ts').PromptContext} PromptContext */

import {
    assembleSystemPrompt,
    assembleUserConstraints,
    buildMessages,
    formatCharacters,
    formatEstablishedMemories,
    resolveLanguageInstruction,
} from '../shared/formatters.js';
import { getExamples } from './examples/index.js';
import { EVENT_ROLE } from './role.js';
import { EVENT_RULES } from './rules.js';
import { EVENT_SCHEMA } from './schema.js';

/**
 * Build the event extraction prompt (Stage 1).
 * @param {BasePromptParams & { forceFullNames?: boolean }} params - Prompt builder parameters
 * @returns {LLMMessages} Array of {role, content} message objects
 */
export function buildEventExtractionPrompt({
    messages,
    names,
    context = /** @type {PromptContext} */ ({}),
    preamble,
    prefill,
    outputLanguage = 'auto',
    narrator = null,
    forceFullNames = false,
}) {
    const { char: characterName, user: userName } = names;
    const safeCharName = characterName || 'Character';
    const safeUserName = userName || 'User';
    const {
        memories: existingMemories = [],
        charDesc: characterDescription = '',
        personaDesc: personaDescription = '',
    } = context;

    const systemPrompt = assembleSystemPrompt({
        role: EVENT_ROLE,
        examples: getExamples(outputLanguage),
        outputLanguage,
    });

    const memoriesSection = formatEstablishedMemories(existingMemories);
    const charactersSection = narrator
        ? `<narrator>${narrator} is the storyteller voicing all NPCs — not a character.</narrator>\n<characters>\n<character name="${safeUserName}" role="user"/>\n</characters>`
        : formatCharacters(safeCharName, safeUserName, characterDescription, personaDescription);
    const contextParts = [memoriesSection, charactersSection].filter(Boolean).join('\n');
    const contextSection = contextParts ? `<context>\n${contextParts}\n</context>\n` : '';

    const languageInstruction = resolveLanguageInstruction(messages, outputLanguage);
    const constraints = assembleUserConstraints({
        rules: EVENT_RULES,
        schema: EVENT_SCHEMA,
        languageInstruction,
    });

    const userPrompt = `${contextSection}
<messages>
${messages}
</messages>

Analyze the messages above. Extract events only.
${
    narrator
        ? `The messages are narrated by ${narrator}, who voices many different NPCs — ${narrator} is NOT a character and must never appear in characters_involved, witnesses, emotional_impact, or relationship_impact. Attribute each event to the actual NPC named in the prose (the one speaking or acting). Use the user's character name ${safeUserName} exactly. Use EXACT character names as written; never transliterate them into another script.`
        : `Use EXACT character names: ${safeCharName}, ${safeUserName}. Never transliterate these names into another script.`
}${
        forceFullNames
            ? '\n\nIMPORTANT: Always use each character\u2019s FULL name (given name + surname/family name) exactly as it is established in the story \u2014 never reduce a character to a first name only. If only a first name has been used so far, record that first name as-is rather than inventing a surname. Using full names keeps distinct characters who share a first name from being wrongly merged.'
            : ''
    }

${constraints}`;

    return buildMessages(systemPrompt, userPrompt, prefill || '', preamble);
}
