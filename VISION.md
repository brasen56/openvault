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

## Brainstorming discipline

When using other models / Cline to expand on this: **lock this framing first,
then diverge.** An unconstrained "brainstorm dossier ideas" prompt produces piles
of open-ended RAG-flavored suggestions — the exact noise this document exists to
cut. Point the session at `src/deps.js`, `src/events.js`, and the relevant
`ROADMAP_*.md`, and judge every idea against in-scope / out-of-scope above.
