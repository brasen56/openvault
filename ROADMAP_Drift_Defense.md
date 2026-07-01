# ROADMAP — Drift Defense

> Scoped by [VISION.md](VISION.md) — "an evolving character that drifts is *worse*
> than a static card." This roadmap is the machinery that makes evolution **safe**:
> it keeps the reflection-derived dossier internally consistent, grounded in its
> evidence, and free of accreted noise. It is the job VectFox (or any RAG layer)
> *cannot* do, and the highest-confidence use of OpenVault's existing
> embeddings/reranker infra after the pivot retired them from the injection path.

**Sequencing:** harden the core (this roadmap) **before** Stage 3 (consume VectFox
events — see VISION.md). Stage 3 is the biggest, most-coupled piece; feeding richer
events into a dossier that has no drift defenses just produces confident drift
faster. Defenses first, then volume.

---

## The litmus test (read before adding any idea here or to the dossier)

Brainstorming around the dossier keeps regenerating "make it contextual" ideas.
Most are out of scope. Before building any selection/contextual behavior, run it
through both gates — it must pass **both**:

1. **Scene-stable, not per-turn.** Does the behavior change only at scene
   boundaries (new location / cast), or does it recompute every message? Per-turn
   churn makes the sheet flicker and re-opens the RAG fight VISION closed. The
   model must see a consistent character *within a conversation*.
2. **Evidence, not relevance-guessing.** Is the signal a *fact* (who is physically
   on-stage in recent chat / a RAG layer's `characters` array) or a *guess*
   (cosine sim between trait text and the user's message)?

**In scope = passes both. Out of scope = fails either.**

Worked examples:
- ✅ **Relationship scene co-presence** — fact (who's present) + scene-stable. The
  *only* contextual touch this roadmap endorses (Phase 4).
- ❌ **Reorder / contextual-fill / reranker-selected traits** — relevance-guessing,
  usually per-turn. Cut. VectFox owns "what matters right now."
- ❌ **Contextual trait selection of any kind** — *who you are* isn't scene-scoped;
  vanity doesn't switch off when you change rooms. Traits stay importance-ranked.

> Why relationships but not traits? Relationships *are* scene-scoped (relevance
> depends on who's present); identity traits are not. That asymmetry — not
> "stability for its own sake" — is the actual rule.

---

## Cross-cutting principles

- **Flag-only before generative.** Detecting a problem (and surfacing it for human
  resolution) is safe. *Generating* new synthesis to fix it is exactly where drift
  gets introduced. Ship the flaggers first; gate anything generative behind human
  approval and a later phase.
- **Reuse the reusable, fork the rest.** The embeddings module, the reranker, and
  the *architectural template* of the LLM-contradiction pipeline (LLM call shape,
  confidence threshold, `contradiction_analyzed` cache pattern, batch interval)
  are all reusable. **But the contradiction pipeline itself is event-oriented and
  cannot be pointed at reflections as-is** — see Phase 2's "Why fork, not reuse"
  note. The UI shell of `src/ui/duplicates.js` is reusable; its lexical detector
  is not (see Phase 1). Reuse what's actually shaped right; fork what isn't.
- **The dossier is the surface.** Drift warnings live on the dossier card next to
  "mark wrong" (`ROADMAP_Dossier.md` Phase 3) — same correction loop, richer signal.
- **Pure helper → template → wiring**, in that order (mirrors `ROADMAP_Dossier.md`).
- Run `npm run generate-types` after any `src/store/schemas.js` edit; run tests from
  the openvault directory (`npx vitest run`).

---

## Phase 1 — Near-duplicate reflection detection (flag-only) (Complete)

**Goal:** surface two reflections that say the same thing ("Astarion is vain" vs.
"Astarion is prideful") so the user can merge them. Accreted near-dupes are how a
dossier silently inflates one theme into a dominant (and distorted) trait.

### The existing detector is lexical — don't reuse it for this
`src/ui/duplicates.js:findNearDuplicates` *does* compare reflection↔reflection
(line 96 skips only cross-type pairs), but it scores **lexical Jaccard token
overlap**, not embeddings:

```js
tokenize = (text) => new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g,'')
                            .split(/\s+/).filter(t => t.length > 2));
// near-duplicate band: 0.25 <= tokenOverlap < 0.6
```

This phase's motivating example — *"Astarion is vain" vs. "Astarion is prideful"* —
shares **no content words** and has ~0% lexical overlap. The existing detector
would silently miss it. Embeddings catch semantic similarity that Jaccard can't.
**Reuse the UI shell** (the pair-card rendering, keep-A/keep-B/skip/merge actions
in `renderDuplicatePair`); **write a new embeddings-based scorer** alongside the
lexical one. Do not restyle `findNearDuplicates` and call it done.

### Sit below the synthesis-time dedup band
`filterDuplicateReflections` ([reflect.js:88](src/reflection/reflect.js)) already
runs embeddings-based 3-tier dedup at *synthesis time*: reject ≥ 0.90, replace
0.80–0.89. Phase 1 is the **retrospective second line of defense** — catching
near-dupes that slipped past that gate (e.g. embeddings drifted, or two reflections
landed in separate cycles). Set this phase's threshold **below 0.80** (try
0.68–0.78) so it surfaces what synthesis-time dedup missed, rather than re-reporting
pairs already rejected/replaced there.

### Steps
1. Pure scorer — cosine sim between reflection embeddings, per character, above a
   tunable threshold (see band note above). Reuse the embeddings already stored on
   memories via `enrichEventsWithEmbeddings` ([reflect.js:355](src/reflection/reflect.js)).
2. Surface candidate pairs on the dossier card, reusing the pair-card UI from
   `src/ui/duplicates.js:renderDuplicatePair` (styling + keep-A/keep-B/skip/merge
   actions), but driven by the new embeddings scorer instead of the lexical one.
3. Resolution reuses the existing merge/archive path (archive the absorbed
   reflection; keep the evidence trail — union `source_ids` and `parent_ids`).

### Surface: dossier card vs. duplicates panel
The existing duplicates UI lives in its own panel/tab, not on the dossier card.
Decide up front: render inline on the dossier (new surface, more code), or surface
a badge on the dossier that deep-links into the existing duplicates panel with a
reflection filter applied. The badge + deep-link is less code and keeps the
duplicates UX in one place; the inline render is what the "dossier is the surface"
principle implies. Lean: badge + deep-link for v1, inline for v2 if users want it.

### Done when
A character with two redundant reflections (0.68–0.78 cosine, below the
synthesis-time band) shows a merge suggestion, and accepting it collapses them
without losing `source_ids ∪ parent_ids`.

---

## Phase 2 — Contradiction surfacing (flag-only) (Complete)

**Goal:** flag reflections that conflict ("trusts the party" vs. "refuses to be
vulnerable") as drift warnings. This is the automated "demands ASL" defender.

### Why fork, not reuse — the existing pipeline is event-oriented
The LLM-contradiction pipeline (`src/retrieval/llm-contradiction.js`,
`src/retrieval/contradiction.js`) is fully wired and reusable as an *architectural
template* — but it **cannot be pointed at reflections as-is** for three reasons:

1. **Invoked only from extraction, over events.** `checkNewMemoryContradictions` and
   `checkBatchForContradictions` run in `src/extraction/extract.js` as a
   post-extraction hook over freshly-extracted *events*. The plumbing assumes the
   extraction pipeline's batch cadence; reflections land via a different path.
2. **Grouped by character *pair* + opposing sentiment.** The Tier-1 keyword gate
   (`src/retrieval/contradiction.js:detectContradictions`) groups memories by
   `characters_involved` pair overlap and `SENTIMENT_POSITIVE`/`SENTIMENT_NEGATIVE`
   keyword opposition. A reflection is about *one* character's internal trait, not a
   pair's relationship state — neither the pair structure nor the sentiment markers
   fit, so the fast pre-filter rarely fires.
3. **The LLM prompt would suppress the conflicts we want to surface.**
   `buildLLMContradictionPrompt` explicitly instructs the verifier: *"A relationship
   changing over time (enemies → friends) is NOT a contradiction — it is character
   development."* That rule is correct for events but would treat
   "refuses to be vulnerable" vs. "trusts the party" as *development* (not drift),
   suppressing exactly the conflict Phase 2 exists to catch.

**Reuse the template, fork the pipeline:** the LLM call shape
(`callLLM(..., LLM_CONFIGS.contradiction, {structured:true})`), the confidence
threshold, the `contradiction_analyzed` cache pattern (re-keyed for reflection-pair
hashes that self-invalidate on summary edit), the batch interval, and the max-calls
cap are all reusable. The grouping, the pre-filter, and the prompt must be new.

### The hard part: drift vs. development
This is the core prompt-design problem for the fork. Two contradictory present-tense
traits about the same character are **drift** (flag). A superseded past trait plus a
newer evolved one is **development** (do not flag). The discriminator is temporal
ordering, which reflections carry via `created_at` / `extraction_count`:
- newer reflection *replaces* older on the same axis → development
- two present-tense reflections that can't both be true simultaneously → drift

The prompt must receive both reflections' timestamps and be instructed to treat the
older-as-superseded case as non-contradiction. This is a real design task — expect
iteration. Flagging development as drift is the failure mode to defend against
(VISION's "characters that evolve" ethos).

### Steps
1. **New embeddings pre-filter** (cheap gate) — per-character reflection pool,
   grouping by *single character*, not pair. Candidate band: thematically adjacent
   but potentially opposed (a candidate-rich over-fetch that defers the real decision
   to the LLM).
2. **Forked LLM verifier** — new prompt (per "drift vs. development" above), new
   `LLM_CONFIGS` entry, same confidence-threshold + `contradiction_analyzed` cache
   pattern (re-keyed for reflection-pair hashes that self-invalidate on summary
   edit, mirroring the event cache).
3. Render confirmed conflicts as a drift warning on the dossier card. **Flag, do
   not auto-resolve** — the user picks which reflection survives (canon note).

### Cost & latency budget
The existing pipeline caps LLM calls per scan (`llmContradictionMaxCalls`,
default 5) and runs **batched** on an interval (`llmContradictionBatchInterval`),
not inline. Phase 2 should inherit both: a per-scan call cap (reflections are fewer
than events, but the drift-vs-development judgment is harder per pair), and
**batched execution** on the same interval cadence — not at reflection-landing
time. Inline-at-synthesis would add latency to the reflection pipeline and risks
blocking the synthesis path on an external LLM call. The embeddings pre-filter is
what makes batching safe: it bounds the candidate set so the backlog stays small.

### Decisions to make
- New `LLM_CONFIGS.reflectionContradiction` entry, or reuse `contradiction` with a
  forked prompt builder? (Lean: new entry — cleaner, lets the verifier model differ.)
- Reuse `llmContradiction*` settings as-is, or a separate reflection-scoped toggle?
  (Lean: separate toggle `llmReflectionContradictionEnabled`, default off, sharing
  confidence/batch-interval/max-calls with the event pipeline.)
- Should a resolved drift conflict auto-write a canon note, or prompt the user?
  (Lean: prompt — canon notes are authoritative, so a human should author them, but
  pre-fill the suggested constraint from the surviving reflection.)

### Done when
Two conflicting *present-tense* reflections produce a visible drift warning, while
a superseded-then-evolved pair does **not**; resolving a drift warning writes (or
prompts) a canon note that constrains the next reflection cycle.

---

## Phase 3 — Grounding check at synthesis (flag-only) (Complete)

**Goal:** catch an ungrounded reflection — one semantically far from the evidence
it *actually cites* — *before* it lands in the dossier.

### Ground against the FULL cited evidence set (events **and** parents)
At construction ([reflect.js:312-344](src/reflection/reflect.js)) the LLM's
`evidence_ids` are split into two independent buckets:
- `source_ids` — cited **event** ids (non-`ref_`)
- `parent_ids` — cited **reflection** ids (`ref_`-prefixed)

`level` is 2+ whenever *any* reflection is cited (`hasReflectionEvidence`), but the
two buckets are independent — a reflection can cite events **and** reflections at
once. So `source_ids` is **NOT** empty above level 1; what's empty for level 1 is
`parent_ids` (the comment at reflect.js:332 is about `parent_ids`, not `source_ids`).

Therefore the grounding evidence for *any* reflection is `source_ids ∪ parent_ids`.
**Embed both the cited events and the cited parent reflections, and compare the new
reflection against that combined set.** Checking against events alone is
event-oriented and would flag legitimate higher-level synthesis — which abstracts
away from raw events but stays close to its parent reflections — as "ungrounded,"
suppressing exactly the reflection-of-reflection evolution this layer exists to
enable.

### Why this needs no per-level threshold
Including parents in the comparison set is what makes the check level-correct: a
level-3 headline *should* be semantically distant from raw events, but it should be
close to the reflections it synthesizes. Grounding against its own cited evidence
handles that naturally. (If tuning is needed, weight `parent_ids` more than
`source_ids` at higher levels — not a level gate.)

### Edge cases
- A reflection citing *no* evidence at all → flag immediately (ungrounded by
  definition), independent of similarity.
- A cited id whose embedding is missing → skip that id, don't treat absence as
  distance.

### Done when
A reflection whose text is semantically unrelated to the union of its cited events
and parent reflections is flagged before it persists; legitimate higher-level
synthesis (distant from raw events but close to its parents) is **not** flagged.

---

## Phase 4 — Relationship scene co-presence (the one endorsed contextual touch)

**Goal:** when surfacing the dossier's relationships, prioritize edges whose *other*
character is present in the current scene. Passes the litmus test: fact-based
(who's on-stage) + scene-stable (changes only when the cast changes).

### Steps
1. Determine the current scene's cast. Precedence (strongest signal first):
   - **VectFox/RAG `characters` arrays** from recent retrieved events — the
     strongest evidence per the litmus test, and couples to the layer that owns
     "what happened." Read from the coinstalled RAG layer's injected/retrieved
     events when available.
   - **Fallback: name extraction from the last N visible messages** (e.g. N=12).
     Match against `graph.nodes` PERSON keys + aliases (reuse
     `normalizeKey`/`tokenizeName` from the duplicates path) so surface-form
     variants ("Astarion", "the vampire spawn") collapse to one cast member.
   - When neither yields a cast, fall back to pure weight-sort (today's behavior).
2. In the dossier's relationship view, rank co-present edges above absent ones,
   *within* the existing cap — reordering only, never per-turn reselection of
   traits/specifics.

### Guardrail
Relationships only. Traits and specifics stay importance-ranked. This is the line
the litmus test draws; do not let it creep into trait selection.

### Done when
In a scene with characters B and C, character A's dossier surfaces A↔B and A↔C
above a higher-weight-but-absent A↔Z — and trait ordering is unchanged.

---

## Phase 5 (later, gated) — Specifics → headline promotion (generative)

**Deferred on purpose.** Clustering level-1 specifics and *synthesizing* a new
level-2 headline is generative — the one idea here that can *introduce* drift
(the cluster centroid may not match what a human would synthesize). Only worth it
after Phases 1–3 have lived on real chats, and only behind **human approval** (the
suggestion never auto-promotes). Until then, keep it out of the flag-only set.

---

## Relationship to other roadmaps

- **`ROADMAP_Dossier.md`** — the dossier is the surface these warnings render on;
  the correction loop (mark-wrong + canon notes) is the resolution mechanism.
- **Stage 3 (VISION.md)** — comes *after* this roadmap. Richer event input is only
  safe once the dossier can defend itself against drift.


## Note for finish:
- Note: the automated batch-interval cadence wiring (running the scan on the extraction pipeline's interval, like the event contradiction scan) is structured for but not yet connected to `src/extraction/extract.js` — the manual "Scan for drift" button on the dossier card is the user-facing entry point for this phase. The batch wiring can be added in a follow-up by mirroring the event pipeline's `Stage 7` periodic scan block.
