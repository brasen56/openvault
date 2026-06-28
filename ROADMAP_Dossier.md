# ROADMAP — Character Dossier

> Scoped by [VISION.md](VISION.md) — the dossier is the deliverable of OpenVault's
> character-identity positioning (synthesize *who a character has become*, not RAG memory).

A per-character view that synthesizes OpenVault's reflections (and related state) into
a readable "personality sheet," then lets you export and correct it. Built in phases so
each one is independently useful and low-risk.

**Core idea:** the dossier is mostly a *join* over data already stored in
`chatMetadata.openvault` (reflections, character_states, graph, reflection_state). The
reflection `level` field (1 = from events, 2–3 = reflections-of-reflections) gives a
free outline structure: level-3 = headline traits, level-1 = supporting specifics.
Each reflection's `source_ids` / `parent_ids` form an **evidence chain** — the surface
that lets you *see* (and later correct) synthesis drift like "communicates in ASL"
mutating into "demands everyone use ASL."

---

## Cross-cutting principles (keep these as you go)

- **Pure helper → template → wiring**, in that order. Logic lands in `src/ui/helpers.js`
  (pure, unit-testable, no DOM), HTML in `src/ui/templates.js`, events via `$panel.on(...)`
  delegation in `src/ui/side-panel.js`.
- **Read-only until Phase 3.** The first mutation in the whole feature is "mark wrong."
- **One schema change total** (Phase 3 canon notes). Everything else is a join over existing data.
- Run `npm run generate-types` after any `src/store/schemas.js` edit.
- Run tests from the openvault directory: `npx vitest run` (not the parent repo).

---

## ✅ Phase 1 — Dossier view (done, + additions)

Read-only join + UI. `buildCharacterDossier(name, data, reflectionThreshold)` in
`src/ui/helpers.js` is the data spine; the evidence chain is the trust surface.
Reflections come pre-grouped by level (3→1); relationships resolved from graph edges
(bidirectional, alias-aware); progress from `reflection_state` vs threshold.

Tests: `tests/ui/helpers.test.js` (`describe('buildCharacterDossier')`).

---

## Phase 2 — Export (done)

**Goal:** turn a dossier into something portable — copyable text and/or a SillyTavern
lorebook entry. Read-only on OpenVault's side (no mutation).

### Steps
1. **Pure formatter** — `formatDossierAsText(dossier)` in `src/ui/helpers.js`, next to
   `buildCharacterDossier`. Dossier object → plain-text/markdown sheet (headline insights,
   specifics, relationships, current state). Pure = unit-testable, no DOM.
2. **"Copy as text" button** — on the dossier card. Wire through the existing
   `.openvault-export-import-btn` + `data-action` delegation (`src/ui/side-panel.js:463`);
   use `navigator.clipboard.writeText` like `handleCopyMemoryDatabase` (`src/ui/side-panel.js:531`).
3. **Lorebook entry export** — `buildLorebookEntry(dossier)`: map to ST's World Info JSON
   shape (entry `key` = character name + graph aliases, `content` = the formatted sheet).
   Mirror the strip-fields / `EXPORT_SCHEMA_VERSION` discipline in `src/ui/export-import.js:16`.
   Download via the same file-save path as `exportMemoriesToFile`.

### Decisions to make
- One character at a time, or "export all characters" as a bundle? Default to one character at a time; optional for bulk
- Lorebook entry as a standalone import file vs. appending to an existing book.
  (Standalone is far simpler — start there.)

### Done when
You can pull a clean text sheet to the clipboard and a valid `.json` that imports into
ST World Info without hand-editing.

### Testing
Unit-test `formatDossierAsText` and `buildLorebookEntry` against a fixture dossier
(snapshot-style). No new infra.

### Guardrail
Still **export only** — never write into the character card or an existing book
automatically. That's Phase 3+.

---

## Phase 3 — Correction loop (Done)

**Goal:** let you kill a wrong reflection *and* stop it regenerating. This is what
permanently fixes synthesis drift (the "demands ASL" problem).

### Steps
1. **"Mark wrong" on a reflection card** → archive it (reuse `archiveMemories`, already
   used in the manage tab — `src/ui/side-panel.js:963`). Archive, don't delete: keeps the
   evidence trail and it's already excluded from retrieval.
2. **Canon notes store** — a per-character list of authoritative corrections (e.g. "MC
   accommodates others; never demands"). New field in `chatMetadata.openvault`. This
   **requires**:
   - a Zod schema update in `src/store/schemas.js`,
   - a migration under `src/store/migrations/`,
   - `npm run generate-types`.
   This is the one structural change in the whole feature — budget for it.
3. **Feed canon notes into generation** — inject them into the reflection prompt as a
   negative constraint, right where `charDesc` is already passed (`src/reflection/reflect.js:285`
   → `buildUnifiedReflectionPrompt`). Pairs with the grounding rule already in
   `src/prompts/reflection/rules.js`.
4. **Canon notes editor** — small textarea/list on the dossier card to add/remove notes.

### Decisions to make
- "Mark wrong": archive only, or archive + auto-draft a canon note from the bad
  reflection's text? First pass = archive only
- Do canon notes steer **reflection only**, or also **extraction**?
  (Reflection-only is the tighter, safer start.)

### Done when
Marking a reflection wrong archives it, and a canon note demonstrably constrains the
next reflection cycle (verify with debug logging on a real chat).

### Testing
- Canon-notes → prompt merge: unit-testable in `tests/prompts/`.
- Migration: add a case in `tests/store/migrations.test.js`.

---

## Phase 4 (optional stretch) — Feedback into canon

Propose character-card / lorebook *diffs* from the dossier for human approval — never
auto-apply. Only worth it once Phases 2–3 have lived on a few real chats.

---

## ✅ Identity-layer injection mode (done)

The pivot from VISION.md: OpenVault no longer has to compete with a RAG memory
extension (VectFox) on per-turn event injection. Set **injection mode → Identity**
and OpenVault injects a stable per-character dossier (the `formatDossierAsText`
sheet) instead of retrieving events. Extraction keeps running — reflections still
need events as raw material.

- `injectionMode: 'events' | 'identity'` (default `events`, so existing users are
  unaffected).
- A character is auto-injected once they have >= `identityMinReflections`
  synthesized reflections; per-character **Always/Never** overrides
  (`injection_overrides`, settable from the dossier card) force or suppress
  individuals.
- The sheet injects into its own slot (`openvault_identity`, alongside the
  character card); the legacy event/world slots are cleared in identity mode so
  OpenVault never collides with a coinstalled memory extension.
- Spine: `src/injection/identity.js` (`getInjectableCharacters`,
  `buildIdentityInjectionText`, `updateIdentityInjection`), wired at the
  `GENERATION_AFTER_COMMANDS` branch in `src/events.js`.

## Background / related

- A grounding rule was added to `src/prompts/reflection/rules.js` (and the draft-process
  "Grounding check" step) to *prevent* intent-escalation drift at generation time. The
  correction loop (Phase 3) is the *cleanup* counterpart — both are wanted (prevention +
  correction), partly because the 3-tier dedup in `src/reflection/reflect.js` can
  re-entrench a similar wrong theme over time.
- Verify on real data: confirm `reflection.character`, `character_states` keys, and
  `reflection_state` keys use identical name strings. `buildCharacterDossier` normalizes
  defensively, but a quick console check confirms the join lands.
