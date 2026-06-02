# Future Feature: LLM-Based Contradiction Resolution

## Overview

The current keyword-based contradiction filter (`src/retrieval/contradiction.js`) is fast and deterministic, but limited to predefined sentiment keywords. An LLM-based approach would provide deeper semantic understanding and could even *merge* conflicting memories into a single accurate summary.

**Status:** Concept stage — not yet implemented.

---

## Architecture

### Two-Tier Design

```
Tier 1 (Fast, existing):  Keyword filter → catches obvious contradictions
Tier 2 (Deep, new):       LLM verifier  → catches subtle contradictions + merges
```

Tier 1 runs on every retrieval (current behavior). Tier 2 runs asynchronously during chat save or reflection cycles — not during the hot retrieval path.

---

## Phase 1: LLM Contradiction Verifier

### When to Run
- After new memory extraction completes
- Compare the newly extracted memory against existing memories for the same `characters_involved` pair
- Only trigger when Tier 1 flagged a *potential* contradiction (or optionally on a configurable schedule)

### Prompt Template

```
You are analyzing memories from a roleplay session. Determine whether these two memories about the same characters contradict each other.

CHARACTERS: {{character_names}}

MEMORY A (extracted at message {{extraction_count_a}}):
"{{summary_a}}"

MEMORY B (extracted at message {{extraction_count_b}}):
"{{summary_b}}"

Respond in JSON:
{
  "contradicts": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation",
  "newer_is_authoritative": true/false,
  "suggested_merge": null OR "merged summary that preserves both facts"
}
```

### Implementation Sketch

```javascript
// src/retrieval/llm-contradiction.js

import { generateLlmResponse } from '../llm.js';
import { logDebug } from '../utils/logging.js';

const CONTRADICTION_PROMPT = `...`; // template above

/**
 * Use LLM to verify a potential contradiction flagged by keyword filter.
 * @param {Memory} memoryA - First memory
 * @param {Memory} memoryB - Second memory  
 * @param {string[]} characterNames - Characters involved
 * @returns {Promise<{contradicts: boolean, confidence: number, merge: string|null}>}
 */
export async function verifyContradiction(memoryA, memoryB, characterNames) {
    const prompt = CONTRADICTION_PROMPT
        .replace('{{character_names}}', characterNames.join(', '))
        .replace('{{extraction_count_a}}', String(memoryA.extraction_count ?? 0))
        .replace('{{summary_a}}', memoryA.summary)
        .replace('{{extraction_count_b}}', String(memoryB.extraction_count ?? 0))
        .replace('{{summary_b}}', memoryB.summary);

    const response = await generateLlmResponse(prompt, { json: true });
    const parsed = JSON.parse(response);
    
    logDebug(`LLM contradiction check: ${parsed.contradicts ? 'CONFLICT' : 'OK'} (confidence: ${parsed.confidence})`);
    
    return {
        contradicts: parsed.contradicts && parsed.confidence >= 0.7,
        confidence: parsed.confidence,
        merge: parsed.suggested_merge,
        newerIsAuthoritative: parsed.newer_is_authoritative,
    };
}
```

---

## Phase 2: Memory Merging

When the LLM confirms a contradiction and provides a `suggested_merge`, automatically merge the two memories into one.

### Merge Strategy

```javascript
/**
 * Merge two conflicting memories into one.
 * The older memory gets archived; the newer memory's summary is replaced.
 */
export async function mergeContradictingMemories(olderMemory, newerMemory, mergedSummary) {
    // Archive the older memory (soft delete)
    olderMemory.archived = true;
    olderMemory.archive_reason = 'contradiction_merge';
    olderMemory.merged_into = newerMemory.id;

    // Update the newer memory with the merged summary
    newerMemory.summary = mergedSummary;
    newerMemory.merge_sources = [olderMemory.id, newerMemory.id];
    newerMemory.merge_timestamp = Date.now();

    // Preserve the higher importance
    newerMemory.importance = Math.max(olderMemory.importance, newerMemory.importance);

    // Merge token lists for BM25
    newerMemory.tokens = [...new Set([
        ...(olderMemory.tokens || []),
        ...(newerMemory.tokens || []),
    ])];
}
```

### What the Merged Summary Looks Like

**Before:**
- Memory A (msg 50): "Alex and Ezra are bitter enemies who hate each other"
- Memory B (msg 200): "Alex and Ezra reconciled and became close friends"

**After merge:**
- Archived: Memory A
- Memory B (updated): "Alex and Ezra were initially enemies but later reconciled and became close friends"

This preserves the narrative arc while eliminating the contradiction.

---

## Phase 3: Batch Contradiction Scan

### Scheduled Scan
Run a periodic scan of all memories (not just newly extracted ones) to find contradictions the keyword filter missed.

```
Trigger: Every N messages (configurable, e.g., every 100 messages)
Scope:   All active memories grouped by characters_involved pairs
Budget:  Max 5 LLM calls per scan (to control cost)
```

### Implementation

```javascript
export async function batchContradictionScan(allMemories, maxCalls = 5) {
    // Group by character pairs
    const groups = groupMemoriesByCharacterPair(allMemories);
    
    let callsUsed = 0;
    const results = [];

    for (const [pairKey, memories] of groups) {
        if (callsUsed >= maxCalls) break;
        if (memories.length < 2) continue;

        // Only check pairs that Tier 1 flagged as suspicious
        // OR pairs where memories span a large extraction_count gap
        const suspicious = findSuspiciousPairs(memories);
        
        for (const [memA, memB] of suspicious) {
            if (callsUsed >= maxCalls) break;
            
            const result = await verifyContradiction(memA, memB, /* chars */);
            callsUsed++;
            
            if (result.contradicts && result.merge) {
                const older = memA.extraction_count < memB.extraction_count ? memA : memB;
                const newer = older === memA ? memB : memA;
                await mergeContradictingMemories(older, newer, result.merge);
                results.push({ older: older.id, newer: newer.id, merged: true });
            }
        }
    }

    return results;
}
```

---

## Integration Points

### 1. Post-Extraction Hook
After `extractMemories()` completes, check the new memory against existing ones:

```javascript
// In extraction pipeline (e.g., src/extraction/index.js)
const newMemory = /* just extracted */;
const existingForPair = getMemoriesForCharacters(newMemory.characters_involved);

if (existingForPair.length > 0) {
    // Tier 1: fast keyword check
    const tier1Flags = detectContradictions([newMemory, ...existingForPair]);
    
    if (tier1Flags.contradictions.length > 0) {
        // Tier 2: LLM verification (async, non-blocking)
        queueLlmVerification(newMemory, tier1Flags.contradictions);
    }
}
```

### 2. Reflection Cycle Hook
During reflection generation, scan for contradictions as a preprocessing step:

```javascript
// In src/reflection/ 
const scanResults = await batchContradictionScan(characterMemories, maxCalls = 3);
// Merged memories produce cleaner reflection inputs
```

### 3. Settings
```javascript
// Add to defaultSettings in constants.js:
llmContradictionEnabled: false,     // Master toggle (off by default)
llmContradictionAutoMerge: false,   // Auto-merge or just flag for review
llmContradictionBatchInterval: 100, // Messages between batch scans
llmContradictionMaxCalls: 5,        // Max LLM calls per batch
llmContradictionConfidence: 0.7,    // Minimum confidence to act on
```

---

## Cost Considerations

| Approach | Latency | LLM Cost | Accuracy |
|----------|---------|----------|----------|
| Keyword (current) | ~0ms | Free | ~70% (obvious cases) |
| LLM verify only | ~2s/call | 1 call/contradiction | ~95% |
| LLM verify + merge | ~2s/call | 1 call/contradiction | ~95% + cleaner context |
| Batch scan | Background | 5 calls/100 messages | ~95% comprehensive |

**Recommendation:** Start with Tier 1 only (keyword). Add Tier 2 (LLM verify) behind a toggle. Auto-merge only for confident users who understand the LLM cost.

---

## UI Considerations

### Memory Detail Panel
When a memory has been involved in a contradiction, show:
- ⚠️ icon with tooltip: "This memory was flagged as contradicting memory X"
- If merged: show original summaries in a collapsible section
- "Review Merge" button for manual confirmation

### Settings Panel
- Toggle: "Enable LLM contradiction analysis"
- Toggle: "Auto-merge confirmed contradictions"  
- Slider: "Confidence threshold" (0.5 - 0.95)
- Counter: "LLM calls used this session for contradiction analysis"

---

## Testing Strategy

### Unit Tests
- `verifyContradiction()` with mocked LLM responses
- `mergeContradictingMemories()` preserves importance, tokens, metadata
- `batchContradictionScan()` respects maxCalls budget

### Integration Tests  
- End-to-end: extract conflicting memories → Tier 1 flags → Tier 2 verifies → merge
- Regression: non-contradicting memories are NOT flagged by LLM
- Cost guard: batch scan stops at maxCalls even when more pairs exist

---

## File Structure (Planned)

```
src/retrieval/
  contradiction.js          ← Tier 1: keyword filter (DONE)
  llm-contradiction.js      ← Tier 2: LLM verifier + merger (FUTURE)
  contradiction-prompts.js  ← Prompt templates for LLM calls (FUTURE)

tests/retrieval/
  contradiction.test.js     ← Tier 1 tests (DONE)
  llm-contradiction.test.js ← Tier 2 tests (FUTURE)
```

---

## Open Questions

1. **Merge vs. Suppress:** Should we merge memories (combine summaries) or just suppress the older one? Merging is more accurate but requires LLM trust.
2. **Review Queue:** Should merges require user approval before taking effect? Adds UI complexity but prevents LLM hallucination damage.
3. **Embedding Invalidation:** After merging, the memory's embedding is stale. Need to re-embed or mark as dirty.
4. **Multi-pair Conflicts:** What if memory A mentions (Alex, Ezra, Bob) and memory B mentions (Alex, Ezra) — do we check both pair subsets?
5. **Reflection Triggers:** Should a confirmed contradiction automatically trigger a reflection cycle for that character pair?