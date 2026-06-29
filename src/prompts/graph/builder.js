/**
 * Graph extraction and edge consolidation prompt builders.
 */

/** @typedef {import('../../types.d.ts').GraphPromptParams} GraphPromptParams */
/** @typedef {import('../../types.d.ts').EdgeConsolidationParams} EdgeConsolidationParams */
/** @typedef {import('../../types.d.ts').LLMMessages} LLMMessages */
/** @typedef {import('../../types.d.ts').GraphEdge} GraphEdge */
/** @typedef {import('../../types.d.ts').PromptContext} PromptContext */

import {
    assembleSystemPrompt,
    assembleUserConstraints,
    buildMessages,
    formatCharacters,
    resolveLanguageInstruction,
} from '../shared/formatters.js';
import { getExamples } from './examples/index.js';
import { EDGE_CONSOLIDATION_ROLE, GRAPH_ROLE } from './role.js';
import { EDGE_CONSOLIDATION_RULES, GRAPH_RULES } from './rules.js';
import { EDGE_CONSOLIDATION_SCHEMA, GRAPH_SCHEMA } from './schema.js';

/**
 * Build the graph extraction prompt (Stage B).
 * @param {GraphPromptParams & { forceFullNames?: boolean }} params - Prompt builder parameters
 * @returns {LLMMessages} Array of {role, content} message objects
 */
export function buildGraphExtractionPrompt({
    messages,
    names,
    extractedEvents = [],
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
    const { charDesc: characterDescription = '', personaDesc: personaDescription = '' } = context;

    const systemPrompt = assembleSystemPrompt({
        role: GRAPH_ROLE,
        examples: getExamples(outputLanguage),
        outputLanguage,
    });

    const charactersSection = narrator
        ? `<narrator>${narrator} is the storyteller voicing all NPCs — not a character.</narrator>\n<characters>\n<character name="${safeUserName}" role="user"/>\n</characters>`
        : formatCharacters(safeCharName, safeUserName, characterDescription, personaDescription);
    const contextSection = charactersSection ? `<context>\n${charactersSection}\n</context>\n` : '';
    const eventsSection =
        extractedEvents.length > 0 ? `<extracted_events>\n${extractedEvents.join('\n')}\n</extracted_events>\n` : '';

    const languageInstruction = resolveLanguageInstruction(messages, outputLanguage);
    const constraints = assembleUserConstraints({
        rules: GRAPH_RULES,
        schema: GRAPH_SCHEMA,
        languageInstruction,
    });

    const userPrompt = `${contextSection}
<messages>
${messages}
</messages>

${eventsSection}Based on the messages${extractedEvents.length > 0 ? ' and extracted events above' : ''}, extract named entities and relationships.
${
    narrator
        ? `The messages are narrated by ${narrator}, who voices many different NPCs — ${narrator} is NOT an entity and must never appear as a node or in a relationship. Extract the actual NPCs named in the prose. Use the user's character name ${safeUserName} exactly. Use EXACT character names as written; never transliterate them into another script.`
        : `Use EXACT character names: ${safeCharName}, ${safeUserName}. Never transliterate these names into another script.`
}${
        forceFullNames
            ? '\n\nIMPORTANT: Always use each character\u2019s FULL name (given name + surname/family name) exactly as it is established in the story \u2014 never reduce a character to a first name only. If only a first name has been used so far, record that first name as-is rather than inventing a surname. Using full names keeps distinct characters who share a first name from being wrongly merged.'
            : ''
    }

${constraints}`;

    return buildMessages(systemPrompt, userPrompt, prefill || '', preamble);
}

/**
 * Build the edge consolidation prompt.
 * @param {GraphEdge} edgeData - Edge to consolidate
 * @param {string} [preamble] - System prompt preamble
 * @param {'auto'|'en'|'ru'} [outputLanguage='auto'] - Output language
 * @param {string} [prefill] - Assistant prefill text (required at runtime, throws if missing)
 * @returns {LLMMessages} Array of {role, content} message objects
 */
export function buildEdgeConsolidationPrompt(edgeData, preamble, outputLanguage = 'auto', prefill) {
    const systemPrompt = assembleSystemPrompt({
        role: EDGE_CONSOLIDATION_ROLE,
        examples: [],
        outputLanguage,
    });

    const segments = edgeData.description.split(' | ');
    const segmentText = segments.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const languageInstruction = resolveLanguageInstruction(segmentText, outputLanguage);
    const constraints = assembleUserConstraints({
        rules: EDGE_CONSOLIDATION_RULES,
        schema: EDGE_CONSOLIDATION_SCHEMA,
        languageInstruction,
    });

    const userPrompt = `<edge_data>
Source: ${edgeData.source}
Target: ${edgeData.target}
Weight: ${edgeData.weight}

Timeline segments:
${segmentText}
</edge_data>

Synthesize these relationship developments into ONE unified description.

${constraints}`;

    return buildMessages(systemPrompt, userPrompt, prefill || '', preamble);
}
