# OpenVault

**Local-first memory & evolving character identity for SillyTavern roleplay.**

OpenVault does two things for long roleplays. It gives them a **durable memory** — watching the conversation, extracting the events that matter, and injecting the most relevant ones back into context so characters remember what happened a thousand messages ago. And it gives them an **evolving character identity** — synthesizing those events into per-character insights (reflections) and injecting a stable "who this character has become" sheet, so NPCs grow and stay consistent across the story.

You pick which of the two OpenVault injects via **Injection Mode**:

- **Events** *(default)* — retrieves the most relevant memories per turn.
- **Identity** — injects a bounded per-character dossier synthesized from reflections, leaving "what happened" to a coinstalled RAG extension (e.g. [VectFox](https://github.com/KritBlade/VectFox)). See [Pairing with VectFox](#pairing-with-vectfox) below.

Everything is stored **locally** in the chat’s own metadata. Embeddings run on-device by default. No external memory service is required.

> **Status:** actively developed fork. Author: **Brasen** · Version **24.0** · [github.com/brasen56/openvault](https://github.com/brasen56/openvault)

---

## Highlights

- **Two injection modes** — retrieve memories per turn (Events) or inject a bounded character-identity dossier (Identity). Switchable per chat.
- **Reflections** — once a character accumulates enough significant events, OpenVault synthesizes higher-level insights (and reflections-of-reflections), giving the model "understanding," not just facts. The engine behind Identity mode.
- **Character dossiers** — a per-character view joining reflections, current state, and relationships into a correctable "personality sheet," exportable as text or a lorebook entry. Canon notes lock in authoritative corrections.
- **Automatic extraction** — a background worker turns recent messages into structured memories (summary, importance, participants, witnesses, location, emotional/relationship impact, temporal anchor).
- **Hybrid retrieval** — an alpha-blend of vector similarity and a 4-tier BM25 keyword match, with a forgetfulness curve so old/rarely-used memories fade and important/often-recalled ones stick.
- **Local embeddings (RAG)** — on-device `multilingual-e5-small` by default; optional Ollama, OpenAI-compatible, or SillyTavern Vector Storage backends.
- **Knowledge graph + communities** — entities and relationships are merged into a graph, clustered (Louvain) into communities, and summarized into a rolling global world-state.
- **POV-aware** — memories are filtered by who actually witnessed an event, so characters don't meta-game knowledge they shouldn't have.
- **Contradiction handling** — a fast keyword filter suppresses stale contradicted memories at retrieval time; an optional LLM tier verifies and merges genuine conflicts, retiring outdated facts.
- **Auto-hide** — trims old messages from the live context (by token budget) while their extracted memories keep the continuity.
- **Backfill** — build memory for an existing chat retroactively.
- **Optional reranker** — second-pass reranking via an external rerank API (e.g. Jina, or a local server).

---

## Installation

**Via SillyTavern (recommended):**

1. Open SillyTavern
2. Go to **Extensions → Install Extension**
3. Paste the repo URL: `https://github.com/brasen56/openvault`
4. Click **Install**, then reload SillyTavern

**Manually:**

```bash
cd SillyTavern/data/<user>/extensions
git clone https://github.com/brasen56/openvault
```

### Requirements

- A configured **LLM connection profile** for extraction/reflection (set it under OpenVault's settings; it can differ from your chat model).
- Embeddings work out of the box on-device (no API needed). Optional backends (Ollama / OpenAI-compatible / ST Vector Storage) are configurable.

---

## Usage

### Automatic mode (default)

With OpenVault enabled it just works: it injects relevant memories before each reply and extracts new ones in the background afterward. You don't have to do anything.

### Manual controls

From the OpenVault panel:

- **Backfill chat history** — extract memories from an existing conversation.
- **Run contradiction scan now** — sweep all memories for conflicts (see [Contradiction handling](#contradiction-handling-in-depth) below).
- **Memory browser** — view, filter, edit, and delete memories.
- **Danger zone** — delete the current chat's memories, or wipe all OpenVault data.

---

## Two injection modes

OpenVault runs the same extraction + reflection pipeline in both modes — the only difference is **what gets injected** before each reply.

### Events (default)

Per-turn retrieval: the most relevant memories are scored (alpha-blend of vector similarity + 4-tier BM25, with a forgetfulness curve) and injected within a token budget. This is the original behavior and works standalone.

### Identity

Instead of retrieving events, OpenVault injects a bounded per-character "identity sheet" synthesized from reflections: headline traits, top relationships, current emotional state, and any canon notes. A character is auto-injected once they have enough synthesized reflections (`identityMinReflections`); per-character **Always / Never** overrides on each dossier card let you force a quiet character in or suppress a minor NPC. The sheet is trimmed to a per-character token budget (`identityInjectionBudget`, default 2000) so a well-connected main character can’t flood the context.

Extraction keeps running in Identity mode — reflections still need events as raw material. The legacy event/world slots are cleared so Identity mode never overlaps whatever else you have injecting context.

## Pairing with VectFox

[VectFox](https://github.com/KritBlade/VectFox) is a high-performance RAG memory extension (Qdrant + structured event extraction + hybrid search) that scales to 10k+ messages. VectFox’s own positioning is "memory, not a tracker" — it recommends pairing with a tracker for character state. That is exactly the split OpenVault’s Identity mode fills:

| Layer | Question | Owner |
|---|---|---|
| Episodic memory | *What happened?* | VectFox (RAG retrieval per turn) |
| Character identity | *Who is this person now?* | OpenVault (reflection-synthesized dossier) |

**Setup:** enable both extensions. In OpenVault, set **Injection Mode → Identity**. Each injects into its own prompt slot, so they never collide. (In Events mode, OpenVault competes with VectFox on the same job — pick one.)

See [`VISION.md`](VISION.md) for the full two-layer model.

## How it works

OpenVault runs two pipelines around each turn.

### 1. Extraction (after replies, in the background)

A worker batches unprocessed messages (by token budget / turn count) and runs a multi-stage pipeline:

1. **Event extraction** — the LLM pulls structured events from the batch.
2. **Graph extraction** — entities and relationships are extracted and merged into the knowledge graph.
3. **Enrich & dedup** — events are embedded and near-duplicates are filtered (cosine + token-overlap).
4. **Graph updates** — entities/edges are upserted; long edge descriptions are consolidated.
5. **Reflections** *(deferred during backfill)* — when a character's accumulated importance crosses the threshold, insights are synthesized.
6. **Communities & world state** *(periodic)* — the graph is clustered and summarized into a global world-state.

Phase 1 (events + graph) commits and saves immediately; Phase 2 (reflections + communities) is best-effort and never blocks or corrupts Phase 1 data.

#### Memory types

The LLM extracts structured events with type, importance (1–5), summary, characters involved, witnesses, location, and emotional/relationship impact:

| Type | Description |
|------|-------------|
| **action** | Significant actions taken by characters |
| **revelation** | New information revealed or discovered |
| **emotion_shift** | Changes in emotional state |
| **relationship_change** | Changes in how characters relate to each other |

### 2. Retrieval (before replies)

1. Build a query from the recent context and detected entities.
2. **Fast pass:** score every memory with `Base + BM25` (cheap).
3. **Slow pass:** compute vector cosine similarity only on the top candidates.
4. Blend, budget, and inject the winners — plus relevant world/entity context — within the token budget.

**Scoring (alpha-blend):**

```
Score = (Base + Alpha·VectorBonus + (1−Alpha)·BM25Bonus) × FrequencyFactor
Base  = Importance × e^(−Lambda × Distance)
```

- **Forgetfulness curve:** memories decay with distance; importance-5 memories have a floor and never fully fade.
- **Hit damping:** frequently retrieved memories decay up to 50% slower.
- **Transient memories:** short-term intentions decay ~5× faster.
- **4-tier BM25:** exact multi-word entities (10×) → single-word entities (5×) → corpus-grounded query terms (3×) → novel scene terms (2×). POV names are stripped as stopwords to avoid score inflation.

### Auto-hide

Messages beyond the visible-token budget are hidden from the live prompt in user/assistant pairs. Their memories are still retrieved and injected, so the hidden span effectively becomes a set of summaries.

---

## Configuration

All settings live in the OpenVault settings panel / side panel. Defaults below reflect the current build.

### Core

| Setting | Default | What it does |
|---|---|---|
| Enable OpenVault | `true` | Master on/off. |
| Extraction profile | *(current)* | LLM connection profile used for extraction/reflection. |
| Backup profile | *(none)* | Fallback profile if the primary fails. |
| Debug mode | `false` | Verbose console logging (F12 → Console). |
| Request logging | `false` | Log raw LLM requests/responses. |

### Extraction

| Setting | Default | What it does |
|---|---|---|
| Extraction token budget | `6000` | Token threshold that triggers an extraction batch. |
| Extraction rearview tokens | `3000` | Budget for existing-memory context shown to the extractor. |
| Max turns per batch | `20` | Cap on conversation turns per extraction. |
| Backfill max RPM | `10` | Rate limit for backfill API calls. |
| Max concurrency | `1` | Phase-2 parallelism (kept at 1 to protect local/VRAM-bound setups). |

### Retrieval & scoring

| Setting | Default | What it does |
|---|---|---|
| Final context budget | `8000` | Max tokens of memory/world context injected per reply. |
| Alpha (vector ↔ keyword) | `0.7` | `1.0` = vector only, `0.0` = BM25 only. |
| Vector similarity threshold | `0.5` | Minimum cosine to count as a vector match. |
| Forgetfulness lambda | `0.05` | Base decay rate of the forgetfulness curve. |
| Transient decay multiplier | `5.0` | How much faster short-term memories fade. |
| Bucket min representation | `0.2` | Min share of context reserved per chronological bucket (old/mid/recent). |

### Embeddings

| Setting | Default | What it does |
|---|---|---|
| Embedding source | `multilingual-e5-small` | On-device model name, or `ollama`, `st_vector`, or an OpenAI-compatible endpoint. |
| Ollama URL | *(empty)* | For the `ollama` source. |
| OpenAI-compat URL / key / model | *(empty)* | For an OpenAI-compatible embedding endpoint. |
| Query / doc prefixes | *(empty)* | Auto-populated per model (e5-small works best with none). |

If you switch embedding models, OpenVault detects the mismatch, wipes stale vectors, and regenerates them in the background.

### Reflections

| Setting | Default | What it does |
|---|---|---|
| Generation enabled | `true` | Synthesize higher-level insights automatically. |
| Injection enabled | `true` | Inject reflections into context. |
| Reflection threshold | `40` | Accumulated importance that triggers a reflection. |
| Max reflections / character | `50` | Cap on stored reflections per character. |
| Max reflection level | `3` | Depth of reflections-of-reflections. |

### Contradiction detection

| Setting | Default | What it does |
|---|---|---|
| Contradiction filter (Tier 1) | `true` | Keyword filter that suppresses older, contradicted memories at retrieval time (free, no LLM). |
| LLM contradiction analysis (Tier 2) | `false` | Opt-in LLM verification of flagged conflicts. |
| Auto-merge | `false` | When a conflict is confirmed, archive the older memory and merge its content into the newer one. |
| Confidence threshold | `0.7` | Minimum LLM confidence to act. |
| Batch interval | `100` | Messages between periodic full-store scans. |
| Max LLM calls / scan | `5` | Cost ceiling per scan. |
| Single-character pass | `false` | Opt-in similarity-gated pass for single-subject state changes (e.g. "broke his arm" → "arm healed"). Requires local embeddings. |
| Single-character max calls | `3` | Separate budget for the similarity pass. |
| Similarity threshold | `0.6` | Min embedding cosine to treat two memories as related (tune per model). |

### Auto-hide

| Setting | Default | What it does |
|---|---|---|
| Auto-hide enabled | `true` | Trim old messages from the live prompt. |
| Visible chat budget | `16000` | Max tokens kept visible in chat history. |
| Max visible messages | `0` | Hard message cap (`0` = use token budget only). |
| Frozen replies | `0` | Number of opening bot replies kept always-visible. |

### Optional reranker

| Setting | Default | What it does |
|---|---|---|
| Reranker enabled | `false` | Second-pass reranking via an external rerank API. |
| API URL / key / model | *(empty)* | e.g. Jina, or a local reranker server. |
| Top N / max documents | `20` / `50` | Results returned / candidates sent. |

---

## Contradiction handling (in depth)

Memories drift as stories evolve. OpenVault reconciles them in tiers:

- **Tier 1 — keyword filter (on by default, free).** At retrieval time, memories about the same characters with opposing relationship sentiment are detected; the *older* one is suppressed from injection so the model sees the current state. Sentiment matching is bilingual (English + Russian) and handles negation ("no longer hates" doesn't count as hostility). When recency is ambiguous (e.g. both extracted in the same batch), it abstains rather than guess.
- **Tier 2 — LLM verification (opt-in).** After extraction and on a periodic schedule, flagged conflicts are sent to the LLM, which decides whether they truly contradict (vs. character development over time). With **auto-merge** on, the older memory is archived and its content folded into the newer one — actually *retiring* the outdated fact. Archived memories are excluded from retrieval.
- **Similarity pass (opt-in).** Pair/sentiment matching can't catch single-subject state changes ("Alex broke his arm" → later "Alex's arm healed"). This pass ranks prior memories by embedding similarity and verifies the closest match, so updates to the same fact are caught regardless of relationship vocabulary.

An analyzed-pair cache (content-hash keyed, so it self-invalidates when a memory is edited) prevents the scans from re-spending LLM calls on pairs they've already checked.

---

## Data & storage

All state lives in `chatMetadata.openvault` and travels with the chat file — per-chat, local, portable. Key fields:

- `memories[]` — events and reflections (summary, importance, tokens, characters, witnesses, embedding, flags).
- `graph` — `{ nodes, edges }` knowledge graph.
- `communities` / `global_world_state` — clustered summaries and rolling world state.
- `character_states` — per-character emotion and a POV `known_events` boundary.
- `reflection_state` — per-character accumulated importance.
- `processed_message_ids` — fingerprints of already-extracted messages.
- `contradiction_analyzed` — cache of analyzed memory-pair keys.

No data leaves your machine except the LLM/embedding API calls you configure.

---

## Privacy & local-first

- Memories, graph, embeddings, and caches are stored in the chat metadata on your machine.
- Default embeddings run on-device (transformers.js). External embedding/LLM/rerank endpoints are used **only** if you configure them.

---

## Troubleshooting

- **Nothing is being remembered.** Confirm OpenVault is enabled and an extraction profile is set. Extraction runs in the background after replies — check the console with **Debug mode** on.
- **Contradiction analysis seems idle.** Tier 2 requires `LLM contradiction analysis` on; *retiring/merging* memories additionally requires `Auto-merge`. The single-character pass also requires local embeddings (it no-ops under the `st_vector` source).
- **Switched embedding models and search got weird.** OpenVault wipes and regenerates stale vectors automatically on model change; let the background backfill finish.

---

## Development

```bash
npm install
npm test            # generate types + run vitest
npm run test:run    # vitest only
npm run typecheck   # generate types + tsc --noEmit
npm run lint        # biome + jsdoc checks
npm run generate-types   # regenerate src/types.d.ts from Zod schemas
```

Zod schemas in `src/store/schemas.js` are the source of truth for types; run `generate-types` after changing them. Architecture and data-flow references live in `include/DATA_SCHEMA.md` and the per-directory `CLAUDE.md` files.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE).