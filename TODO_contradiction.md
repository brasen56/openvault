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
   - Per-batch budget caps how many events reach the paid LLM step
     (`llmContradictionMaxCalls`, default 5).
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

---

## 🔧 Remaining work (roughly priority order)

### 1. ST Vector re-sync after an auto-merge  (only affects `embeddingSource: st_vector` + `llmContradictionAutoMerge: true`)
`mergeContradictingMemories()` archives the older memory and rewrites the newer
one's summary, then calls `enrichEventsWithEmbeddings([newer])`. But nothing
updates the **ST Vector index**:
- The archived memory's vector still lives in the index (harmless for
  correctness — retrieval filters `archived` — but it's dead weight and can
  occupy a query slot).
- The merged memory's indexed text is **stale** (old summary), so vector search
  matches the pre-merge wording.

**Fix:** after a merge, push the archived memory to `toDelete` and the updated
memory to `toSync`, then call `applySyncChanges()`. Follow the existing pattern
in `extract.js` (the event-sync block that builds
`{ hash: cyrb53(\`[OV_ID:${id}] ${summary}\`), text, item }`). Easiest path:
have `checkNewMemoryContradictions()` / `mergeContradictingMemories()` return the
affected memory refs (additive — won't break current tests, which only assert
`.verified`/`.merged`), then sync them in `checkBatchForContradictions()`.
See the "ST CHANGES CONTRACT" in `src/store/CLAUDE.md`.

### 2. Add merge-metadata fields to the schema
`mergeContradictingMemories()` writes `archive_reason`, `merged_into`,
`merge_sources`, `merge_timestamp`. These are **not** in `MemorySchema`
(`src/store/schemas.js:19`). They persist today only because `saveOpenVaultData()`
doesn't `.parse()` on save — fragile. Per the "three-point update" rule in
`src/store/CLAUDE.md`, add them to `MemorySchema` and regenerate types
(`npm run generate-types`). Without this they're invisible to any future
validation/migration and to the type system.

### 3. Per-call RPM spacing for contradiction LLM calls
There's a single `rpmDelay()` before Stage 5b, but `checkNewMemoryContradictions()`
can fire up to 3 `callLLM` calls internally with no spacing between them. For
RPM-limited / local users that can burst. Either thread an rpm-aware callback in,
or move the loop out so each `verifyContradiction()` is individually spaced.

### 4. Cost budget is coarse
`checkBatchForContradictions()` caps the number of *events* that reach
verification, not the number of *LLM calls* (each event can cost up to 3). Make
the budget count actual calls if cost becomes a concern.

### 5. Tier 1 grouping: identical set vs. shared pair
`detectContradictions()` keys groups on the **exact** sorted `characters_involved`
set, so `{Alex,Ezra}` and `{Alex,Ezra,Bob}` never compare — despite the comment
saying "share at least 2 characters." Witness-set drift = missed contradictions.
(Design-doc open question #4.) Decide: match on any shared pair, or keep strict.

### 6. Sentiment negation not handled
Keyword classifier flips on negation: "no longer hates" → NEGATIVE,
"stopped being friends" → POSITIVE. Inherent to the heuristic; Tier 2 is the
real backstop. Consider a small negation guard if false suppressions show up.

### 7. `batchContradictionScan()` is implemented + tested but never scheduled
The setting `llmContradictionBatchInterval` (default 100) exists but nothing
reads it. To enable periodic full-store scans (design-doc Phase 3), trigger
`batchContradictionScan()` from the extraction worker on the interval — mirror the
community-detection interval check in `extractMemories()` Phase 2.

### 8. Tier 1 effectiveness caveats (by design, document for users)
- Runs **after** budgeting, on `finalResults` — only catches contradictions when
  *both* memories are co-retrieved in the same turn.
- Freed budget from a suppressed memory is **not** backfilled.
- Suppresses the **entire** losing side, so one recent negative blip hides all
  prior positive history for that pair until a newer positive appears.

### 9. UI surface (design-doc §UI)
No indicator for merged/flagged memories. Consider: ⚠️ badge on memories that
were archived via `archive_reason: 'contradiction_merge'`, a collapsible
"original summaries" view, and a session counter of contradiction LLM calls.

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
| `llmContradictionMaxCalls` | `5` | Per-batch verification budget |
| `llmContradictionBatchInterval` | `100` | **Unused** — see item #7 |

> Note: with `llmContradictionEnabled: true` but `autoMerge: false`, Tier 2 only
> *detects* and logs — nothing is retired. Retirement requires `autoMerge: true`.

## Key files
- `src/retrieval/contradiction.js` — Tier 1 keyword filter (`detectContradictions`, `filterContradictions`)
- `src/retrieval/llm-contradiction.js` — Tier 2 (`checkNewMemoryContradictions`, `batchContradictionScan`, `mergeContradictingMemories`)
- `src/extraction/extract.js` — `checkBatchForContradictions()` + Stage 5b wiring
- `src/retrieval/scoring.js` — Tier 1 invocation (`filterContradictions`, ~line 464)
- `src/extraction/structured.js` — `ContradictionVerificationSchema` / parser
- `future_feature_llm_contradiction.md` — original design doc

## Tests
- `tests/retrieval/contradiction.test.js`, `tests/retrieval/llm-contradiction.test.js` — **all green (54)**.
- The wider suite has some **pre-existing flaky failures** (scheduler / ui-helpers /
  events / extract "zero events") that vary run-to-run from shared test state under
  parallelism — unrelated to this feature. No test for the new `extract.js` Stage 5b
  wiring (the orchestrator test file is intentionally locked per `tests/CLAUDE.md`);
  if you want coverage, test the helper's budget/skip logic at the unit level.
