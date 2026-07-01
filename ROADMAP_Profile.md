# ROADMAP — Character Profile & Retention

> Scoped by [VISION.md](VISION.md) — "the dossier IS the product." This roadmap
> matures the dossier into two coupled things: a **human-readable character
> profile** (LLM-written, user-initiated, exportable) and a **retention policy**
> that lets long chats shed bulk *without* losing the dossier or its evidence.
> They're one roadmap because the profile is what makes retention *safe*.

**Status:** brainstorm / launch point. Nothing here is built. The deterministic
`formatDossierAsSheet` ([src/ui/helpers.js](src/ui/helpers.js)) is the current
rendering and the direct ancestor of Phase A.

---

## The one rule everything here obeys

**The profile is a LEAF, never a ROOT.** It is *rendered from* grounded
reflections; it never becomes a *source* that new reflections synthesize from.
The moment the profile feeds synthesis, you've built a telephone machine —
each regeneration drifts further from evidence with nothing to trace back to
(the "demands ASL" failure at the top of the stack). At most the profile is a
canon-note-style *constraint* passed into the reflection prompt, never cited
evidence.

Corollary — **durable vs prunable:**

| Layer | Role | Prunable? |
| --- | --- | --- |
| Raw events (level-1 memories) | detail / evidence | **Yes — archive** once synthesized |
| Reflections | the dossier *and* the regeneration source | **No** (except the existing mark-wrong path for flat-wrong ones) |
| Profile | a rendering | n/a — regeneratable *only while reflections survive* |

**Regeneration requires the source.** "Shed to save space" and "regenerate
later" only coexist if the shed list is *raw events only*. Pruning reflections
breaks both the dossier and regeneration.

---

## Phase A — Standalone character profile (LLM rendering)

**Goal:** a user-initiated LLM pass that turns the dossier into a polished,
human-readable character sheet / CV — for reading, for a lorebook/character-card
entry, editable, and regeneratable on demand. Answers the real user pain: a
long-standing NPC with 1000s of events is unreadable as a raw dossier.

### Steps
1. **Pure input builder** — assemble the profile's source material from the
   *reflection hierarchy*, not raw events: level-3 → level-2 headlines, canon
   notes (authoritative), relationships (graph edges). Reuse what
   `formatDossierAsSheet` already gathers. Feeding raw events would be expensive
   and noisy; the synthesized levels *are* "who they are."
2. **LLM formatter** — `buildCharacterProfile(dossier)` → prose. Same
   helper→template→wiring pattern as the other formatters; this one makes an LLM
   call (user-initiated, so cost/latency is acceptable).
3. **User-initiated only** — a button on the dossier card. Never automatic, never
   per-turn.
4. **Editable + regeneratable** — the generated profile is stored, user-editable,
   and can be regenerated later from current reflections. Edits are preserved as
   a distinct field or merged with a clear "regenerate overwrites edits" warning.
5. **Provenance** — the profile links the reflections it drew from (same
   evidence-chain discipline as reflections' `source_ids`), so it stays traceable
   and correctable rather than an unfalsifiable blob.
6. **Canon overrides** — user canon notes always outrank anything the profile
   infers.

### Decisions to make
- Store profile per character in `chatMetadata.openvault` (schema + migration +
  `npm run generate-types`), or keep it export-only at first? (Lean: export-only
  first — no schema change — then persist once the shape settles.)
- Regenerate semantics vs. user edits: overwrite-with-warning, or keep edited and
  generated as separate fields the user diffs? (Lean: separate fields.)

### Done when
A user clicks "Generate profile," gets a clean prose sheet built from the
character's reflections, can edit it, export it to a lorebook/card, and
regenerate it later. Zero drift risk because it's downstream of grounded data.

### Possible extension (later, opt-in)
The curated profile could be what **identity mode injects** instead of the
bounded 10/6/6 dossier — more coherent and token-efficient. Caveat: it's a lossy
synthesis, so this stays a user option, not the default. Same leaf-not-root rule:
injecting it is fine; feeding it back into synthesis is not.

---

## Phase B — Retention / pruning (raw events only)

**Goal:** let long chats shed bulk. Real motivation: power-user chats reach tens
of MB (a known ~78 MB chat is being hand-pruned message-by-message today). The
weight is overwhelmingly **raw events + their embeddings**, not reflections.

### Measure before building
Confirm this is worth it first:
- In **identity mode**, retrieval doesn't run — so raw events cost *storage +
  embedding footprint*, not per-turn compute. Some of "500+ feels heavy" is the
  events-mode per-turn scoring the pivot already removes.
- (The 250 MB cases were an *external summarizer bug*, since fixed — not
  representative. Target the genuine ~78 MB manual-pruning case.)

### Steps
1. **Archive, don't hard-delete** — reuse the existing `archived` flag / auto-hide
   machinery. A level-1 event becomes prunable once it's been synthesized into a
   reflection *and* passes an age/where-in-chat threshold.
2. **Never touch reflections** — only the existing mark-wrong path archives a
   reflection (a flat-wrong one), and that's drift *correction*, not retention.
3. **Graceful dangling references** — archived events leave reflections'
   `source_ids` pointing at absent items. The grounding check already handles this
   (missing embedding → skipped, not treated as distance). The dossier's
   **evidence-chain UI** must show such evidence as "archived," not break.
4. **Optional: drop embeddings before the record** — the embedding is the heavy
   part. Archiving *just the embedding* of a synthesized old event reclaims most
   of the space while keeping the event's text for the evidence trail.

### Decisions to make
- Prune the whole event, or just its embedding? (Embedding-only is the bigger
  space win per unit of risk — start there.)
- Auto-suggest pruning at a threshold, or fully manual? (Lean: manual/opt-in,
  consistent with "user-initiated" everywhere else in the dossier.)

### Done when
A user on a heavy chat can archive synthesized old events (or their embeddings),
measurably shrink the chat file, and still see an intact dossier + a
regeneratable profile — with the evidence chain showing archived items rather
than breaking.

---

## What NOT to build (the trap, restated)

Do **not** wire a path where events are pruned → reflections are pruned → the
profile becomes the sole survivor → new reflections synthesize from the profile.
That is the drift machine this whole architecture exists to prevent. Profile =
leaf. Reflections = durable. Raw events = prunable detail.

---

## Relationship to other roadmaps

- **`ROADMAP_Dossier.md`** — the profile is the matured export/render of the
  dossier; edits ride the same correction surface (canon notes, mark-wrong).
- **`ROADMAP_Drift_Defense.md`** — the grounding check's missing-embedding
  handling is *what makes Phase B safe*; contradiction/dedup keep reflections
  clean enough that a profile built from them is trustworthy.
- **Stage 3 (VISION.md)** — orthogonal; retention prunes OpenVault's own events
  regardless of whether extraction is OpenVault's or VectFox's.
