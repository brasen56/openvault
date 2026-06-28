# VISION — OpenVault

What OpenVault is *for*. This is the north star that scopes every roadmap
(`ROADMAP_Dossier.md`, `ROADMAP_Batch_operations.md`, `ROADMAP_Future.md`).
When a feature idea doesn't serve this, it belongs in someone else's extension.

---

## One-line positioning

**OpenVault is the evolving character-identity layer for SillyTavern — it
synthesizes *who a character has become*, and keeps them consistent and real as
the story grows.** It is not a memory-retrieval engine.

---

## The two-layer model

Long-form roleplay has two distinct problems. They are usually conflated, and
that's why most "memory" extensions feel muddy.

| Layer | Question it answers | Shape | Owner |
| --- | --- | --- | --- |
| **Episodic memory** | *What happened?* | Many event records, retrieval-gated, payload changes every turn | a RAG system (e.g. VectFox + Qdrant) |
| **Character identity** | *Who is this person now?* | One synthesized, mostly-stable sheet per character; shifts only when reflections shift | **OpenVault** |

OpenVault used to compete on the first layer (its own retrieval + embeddings +
scoring, injected via `setExtensionPrompt(...IN_CHAT)`). That's a fight against
purpose-built vector databases — the wrong tool for the job. The reflections
pipeline is the actual gem: watching the LLM synthesize events into character.

**So OpenVault gives up episodic retrieval and owns identity instead.** The two
layers are complementary, not rival — a RAG layer can sit underneath OpenVault
and answer "what happened" while OpenVault answers "who they are."

---

## What this means concretely

1. **Inject a stable character state, not retrieval-gated events.** The injected
   payload is a small, persistent "who this character is right now" sheet —
   closer to an evolving Author's Note than to RAG. Roughly the same every turn;
   it only moves when a reflection lands. This deletes most of the per-turn
   retrieval/embedding complexity from the *injection* path.

2. **The dossier IS the product.** Not a side view. The dossier
   (`buildCharacterDossier`, `ROADMAP_Dossier.md`) is the live, evolving
   character sheet — the thing that gets injected and/or exported to the
   character card / lorebook. Reflections feed it; the evidence chain makes it
   trustworthy.

3. **Reflections are the engine.** Memories → Reflections → Dossier is the spine.
   Reflection `level` gives the outline (headline traits → specifics);
   `source_ids` / `parent_ids` give the evidence chain.

4. **Drift control is non-negotiable.** An evolving character that drifts is
   *worse* than a static card. The grounding rules (`src/prompts/reflection/`)
   and the correction loop (archive + canon notes, `ROADMAP_Dossier.md` Phase 3)
   are not extras — they are what makes "characters that evolve" safe to ship.
   The "demands ASL" failure is the canonical thing we defend against.

---

## In scope / out of scope

**In scope** — anything that makes a character more consistent, more real, or
better at evolving *grounded in evidence*:
- Synthesizing reflections into a readable, correctable identity sheet
- Injecting that identity into generation as stable character context
- Exporting identity to character cards / lorebooks
- Letting the user correct synthesis drift (mark-wrong, canon notes)
- Deriving relationships as a *view over reflections with sources* (graph edges)

**Out of scope** — defer to the episodic-memory / tracker layer:
- Episodic event retrieval ("remember when we…") — that's the RAG layer's job
- Competing on vector-search accuracy, sparse/dense hybrid, rerankers
- Numeric stat matrices that auto-mutate (trust++, cynicism>80 → terse). This is
  ungrounded drift by construction — the opposite of the evidence-chain
  philosophy. If relationships are wanted, derive them from reflections, don't
  invent free-floating scalars.
- Per-turn hidden "unconscious thought" inference — redundant once a RAG layer
  injects context, and it taxes latency on top of a second extension.

---

## Open coordination questions (when running alongside a RAG layer)

Not blockers — design notes for when OpenVault and an episodic-memory extension
run together:

- **Shared prompt budget.** Both inject via `setExtensionPrompt`. A stable
  identity sheet is small and predictable (unlike variable event payloads) —
  give it its own depth slot and keep it tight.
- **Double extraction cost.** Both run LLM extraction passes over the same chat.
  Long-term, OpenVault could *consume the RAG layer's structured events* as raw
  material instead of extracting its own (events already carry characters,
  cause, result, concepts). Tight coupling — not now, but it's the natural
  endgame of "events feed identity."

---

## Implementation status

Tracking the pivot from competing-on-RAG to owning identity. Commits are on
branch `testing`.

### Done

- **Stage 1 — Identity injection mode** (`edd5bf0`). New `injectionMode:
  'events' | 'identity'` (default `events`, so existing users are unaffected).
  In Identity mode the pre-generation hook (`src/events.js`) injects a stable
  per-character dossier into its own slot (`openvault_identity`); the legacy
  event/world slots are cleared so it never overlaps a coinstalled memory
  extension. A character auto-injects once they have ≥ `identityMinReflections`
  insights, with per-character Always/Never overrides (`injection_overrides`,
  v6 migration). Spine: `src/injection/identity.js`.
- **Token-budget fix** (`747423e`). A dedicated bounded formatter
  (`formatDossierForInjection`) caps each section (top 10 headline traits, top
  6 relationships by weight, top 6 specifics) and trims to a per-character
  token budget (`identityInjectionBudget`, default 2000). Without this a
  well-connected main character flooded the context (151k+ chars observed on a
  real chat). The export formatter (`formatDossierAsText`) is unchanged.
- **Stage 2 — README repositioning + side-panel toggle** (`723295d`). Dual-value
  framing (memory + identity), a "Pairing with VectFox" section with the
  two-layer table, and the mode selector mirrored into the side panel.
- **Dossier Phases 1–3** (predates the pivot, already shipped). The reflection
  engine, the read-only dossier join (`buildCharacterDossier`), text/lorebook
  export, and the correction loop (mark-wrong + canon notes + negative
  constraint in the reflection prompt). See `ROADMAP_Dossier.md`.

### Stage 3 — Consume VectFox's events as the reflection feed (todo)

This is the "natural endgame" flagged in the coordination questions above.
Currently OpenVault runs its *own* extraction over the chat to feed
reflections, so a VectFox user pays double extraction cost. Stage 3 is an
adapter that, when enabled, reads VectFox's structured EventBase events
(characters / concepts / cause / result) as the raw material for reflections
**instead of** OpenVault's own extraction. Opt-in per user; OpenVault's own
extraction remains the default for anyone not on VectFox or with pre-VectFox
long histories (per the polled user base). This is the only remaining large
piece — it stays behind extraction's existing seam (`src/extraction/`).

### Pre-existing test failures (unrelated to the pivot — fix when convenient)

These 5 failures reproduce on a clean checkout of `testing` and are **not**
caused by the pivot. They are noise in the test output; the pivot's own suites
(identity, v6 migration, dossier, helpers) are green.

- **`tests/utils/st-helpers.test.js`** (4 failures) — the `safeSetExtensionPrompt`
  position/depth tests. The tests assert `POSITION_MAP` maps position code `2`
  to `0` (IN_PROMPT) but the map in `src/utils/st-helpers.js` returns `2`
  (BEFORE_PROMPT). The tests and the implementation disagree on the legacy
  position-code semantics; the tests predate the current map. Affected tests:
  *"calls setExtensionPrompt and returns true on success"*, *"passes custom
  name"*, *"defaults to extensionName"*, *"passes position and depth parameters"*.
- **`tests/extraction/extract.test.js`** (1 failure) — *"graph extraction with
  zero events > runs graph extraction even when zero events are extracted"*
  expects `mockData.graph.nodes['shadow guild']` to be defined. A graph-node
  normalization / mock-setup issue in the test itself, not in production code.

---

## Brainstorming discipline

When using other models / Cline to expand on this: **lock this framing first,
then diverge.** An unconstrained "brainstorm dossier ideas" prompt produces piles
of open-ended RAG-flavored suggestions — the exact noise this document exists to
cut. Point the session at `src/deps.js`, `src/events.js`, and the relevant
`ROADMAP_*.md`, and judge every idea against in-scope / out-of-scope above.


Future Considerations: Currently character dossiers injects with 10 headline traits, 6 relationships, 6 specifics and respects per-character token budget (default 2000, configurable 500-9000 via slider). Possible to use dynamic traits/relationships based on context?