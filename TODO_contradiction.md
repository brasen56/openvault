# TODO — Contradiction Detection / Memory Retirement

Status notes for the two-tier contradiction system. Tier 1 = keyword filter
(`src/retrieval/contradiction.js`), Tier 2 = LLM verifier/merger
(`src/retrieval/llm-contradiction.js`). Goal: retire/merge old memories when
newer ones contradict them.

---

## ✅ Done (this pass)

1. **Wired Tier 2 into the extraction pipeline.**
   - `checkNewMemoryContradictions()` is now called from `extractMemories()`
     Phase 2 ("Stage 5b") in `src/extraction/extract.js`, via the private helper
     `checkBatchForContradictions()`.
   - Gated by the `llmContradictionEnabled` setting (off by default).
   - Runs only when the batch produced events; skipped during backfill (the
     early `return` in the `isBackfill` branch sits above it).
   - Per-batch budget caps actual LLM calls (`llmContradictionMaxCalls`, default 5).
   - Merges mutate `data.memories` in place; persisted by the existing final
     `saveOpenVaultData()`. Retrieval already excludes `archived` memories
     (`src/retrieval/retrieve.js:503` and `:620`), so an archived memory really
     does drop out of injection — the "retire" works.

2. **Fixed the Tier 1 recency tie-break.**
   - In `detectContradictions()`, when the most-recent positive and negative
     memories have **equal** recency, we now **abstain** (suppress neither)
     instead of defaulting to "negative wins."
   - Why it mattered: every event in one extraction batch shares a single
     `extraction_count` (see `src/extraction/extract.js`, where all events in a
     batch get the same stamp). The old `>` comparison meant a same-scene
     "they argued THEN made up" batch would suppress the *reconciliation*
     (positive) memory and keep the fight — backwards. Same-batch conflicts are
     now left for Tier 2, which can read narrative order.

3. **ST Vector re-sync after auto-merge** (#1).
   - `mergeContradictingMemories()` now returns pre-merge summaries
     (`olderPreMergeSummary`, `newerPreMergeSummary`) alongside the mutated
     memory objects.
   - `checkNewMemoryContradictions()` propagates this as `stSync` in its return
     value when a merge occurred.
   - `checkBatchForContradictions()` consumes `stSync` and pushes the correct
     `toDelete` (archived memory's old hash, updated memory's stale hash) and
     `toSync` (updated memory with new merged summary) to `applySyncChanges()`.
   - Only runs when `isStVectorSource()` is true — no overhead for local/ollama.

4. **Merge-metadata fields added to schema** (#2).
   - `archive_reason`, `merged_into`, `merge_sources`, `merge_timestamp` added
     to `MemorySchema` in `src/store/schemas.js`.
   - Removed all `@type {any}` casts in `mergeContradictingMemories()` — fields
     are now properly typed.
   - Types regenerated via `npm run generate-types`.

5. **Per-call RPM spacing for contradiction LLM calls** (#3).
   - `checkNewMemoryContradictions()` accepts an `rpmDelayFn` option (async
     callback). It's called between LLM verifications (i.e., after the first
     call returns, before the next one fires).
   - `checkBatchForContradictions()` passes `() => rpmDelay(settings, ...)`
     so each call respects the shared rate limiter.

6. **Cost budget counts actual LLM calls** (#4).
   - `checkNewMemoryContradictions()` now returns `llmCallsUsed` (counting both
     successful and failed LLM calls, but not cheap skips like neutral sentiment
     or no overlap).
   - `checkBatchForContradictions()` tracks `totalLLMCalls` across events and
     stops when `maxLLMCalls` is exhausted. Each event's remaining budget is
     passed as `maxCalls` to `checkNewMemoryContradictions()`.

7. **Periodic full-store batch contradiction scan** (#7).
   - Added as Stage 7 in `extractMemories()` Phase 2, after community detection.
   - Mirrors the community-detection interval pattern: fires when
     `graph_message_count` crosses a multiple of `llmContradictionBatchInterval`.
   - Only runs when both `llmContradictionEnabled` AND `llmContradictionAutoMerge`
     are enabled.
   - Re-embeds merged memories after the scan.
   - `batchContradictionScan()` imported in `extract.js`.

---

## 🔧 Remaining work (roughly priority order)

### 5. ~~Tier 1 grouping: identical set vs. shared pair~~ ✅ Done
Tier 1 (`detectContradictions`) kept strict as designed. Tier 2 batch scan
(`groupMemoriesByCharacterPair` in `llm-contradiction.js`) now uses **pairwise
overlap**: a memory with `{Alex,Ezra,Bob}` is added to every 2-character subset
group (`alex|ezra`, `alex|bob`, `ezra|bob`), so it will be compared against
memories in any of those groups. This eliminates the witness-set drift gap
without making the fast Tier 1 path more expensive.

### 6. ~~Sentiment negation not handled~~ ✅ Done
`classifySentiment()` now includes a negation guard (`isNegated()`) that checks
for `SENTIMENT_NEGATORS` within a 3-token window before each keyword match.
Negated keywords are **dropped** (neutralized) rather than flipped — safe and
conservative. Multi-word phrase matches are also negation-aware via
`phraseStartIndex()`.

### 8. ~~Tier 1 effectiveness caveats~~ ✅ Done
Added an informational `<details>` block in the side panel Settings tab
(`templates/side_panel.html`) explaining the three by-design limitations:
- Only catches contradictions when both memories are co-retrieved in the same turn.
- Freed budget from a suppressed memory is not backfilled.
- Suppresses the entire losing sentiment side for the group.

### 9. UI surface (design-doc §UI) — ✅ Done
- ✅ Added "Settings" tab to the side panel (`templates/side_panel.html`) with:
  - ✅ Contradiction Filter toggle (Tier 1 on/off)
  - ✅ LLM Contradiction Analysis toggle (Tier 2 on/off) with collapsible sub-options
  - ✅ Auto-merge checkbox
  - ✅ Batch Scan Interval slider (10–500, default 100)
  - ✅ Max LLM Calls per Scan slider (1–20, default 5)
  - ✅ "Run Contradiction Scan Now" button (manual trigger)
- ✅ Wired all controls in `src/ui/settings.js` (`bindUIElements` + `updateUI`)
- ✅ Added contradiction keys to `RESETTABLE_KEYS` for settings reset
- ✅ Added `llmContradictionBatchInterval` / `llmContradictionMaxCalls` to `UI_DEFAULT_HINTS`
- ✅ Badge on archived memories — `renderSideMemoryItem()` now renders an
  `📦 Archived` badge and merged-source info when `memory.archived` is true,
  and a `🔗 Merged` badge with collapsible original summaries when
  `merge_sources` is present.
- ✅ Collapsible original summaries view — merged memory cards show a
  `<details>` block with the merge timestamp and source memory IDs.
- ✅ Session LLM call counter — a live counter (`#openvault_side_contradiction_session_calls`)
  in the contradiction settings section shows how many LLM contradiction calls
  have been made this session; incremented by the batch scan and manual scan.

### 10. Order vs. reflections (minor)
Stage 5b currently runs **after** `synthesizeReflections()`. The design doc
suggests resolving contradictions *before* reflection so reflections build on
merged/clean inputs. Left as-is to avoid perturbing the reflection path; revisit
if auto-merge is commonly enabled.

---

## Settings (in `src/constants.js` `defaultSettings`)
| key | default | meaning |
|---|---|---|
| `contradictionFilterEnabled` | `true` | Tier 1 keyword suppression at retrieval |
| `llmContradictionEnabled` | `false` | Master toggle for Tier 2 LLM checks |
| `llmContradictionAutoMerge` | `false` | Archive+merge on confirmed contradiction (vs. just log) |
| `llmContradictionConfidence` | `0.7` | Min confidence to act on |
| `llmContradictionMaxCalls` | `5` | Per-batch LLM call budget (actual calls, not events) |
| `llmContradictionBatchInterval` | `100` | Messages between periodic full-store scans |

> Note: with `llmContradictionEnabled: true` but `autoMerge: false`, Tier 2 only
> *detects* and logs — nothing is retired. Retirement requires `autoMerge: true`.

## Key files
- `src/retrieval/contradiction.js` — Tier 1 keyword filter (`detectContradictions`, `filterContradictions`)
- `src/retrieval/llm-contradiction.js` — Tier 2 (`checkNewMemoryContradictions`, `batchContradictionScan`, `mergeContradictingMemories`)
- `src/extraction/extract.js` — `checkBatchForContradictions()` + Stage 5b wiring + Stage 7 batch scan
- `src/retrieval/scoring.js` — Tier 1 invocation (`filterContradictions`, ~line 464)
- `src/extraction/structured.js` — `ContradictionVerificationSchema` / parser
- `src/store/schemas.js` — `MemorySchema` with merge metadata fields
- `future_feature_llm_contradiction.md` — original design doc

## Tests
- `tests/retrieval/contradiction.test.js`, `tests/retrieval/llm-contradiction.test.js` — **all green (54)**.
- The wider suite has some **pre-existing flaky failures** (scheduler / ui-helpers /
  events / extract "zero events") that vary run-to-run from shared test state under
  parallelism — unrelated to this feature. No test for the new `extract.js` Stage 5b
  wiring (the orchestrator test file is intentionally locked per `tests/CLAUDE.md`);
  if you want coverage, test the helper's budget/skip logic at the unit level.