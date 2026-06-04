# OpenVault — Future Feature Roadmap

This document tracks planned features and improvements for future releases.

---

## Priority: Medium

### Additional Slash Commands

| Command | Purpose |
|---------|---------|
| `/openvault-clear` | Clear all memories from current chat (with confirmation) |
| `/openvault-backfill` | Trigger backfill extraction directly |
| `/openvault-emergency-cut` | Trigger emergency cut extraction directly |

Currently only `/openvault-extract`, `/openvault-retrieve`, `/openvault-status`, and `/openvault-panel` are exposed. The above commands would give users chat-level access to operations that currently require the UI panel.

### "Show Archived" Toggle
Memories tab should filter `!m.archived` by default with a toggle to show archived memories. The `archived` field is already in the schema and retrieval filters on it.

---

## Priority: Low

### Import Memory Re-embedding
When importing memories from a JSON export, embeddings are stripped (by design). For imported memories to be fully searchable via vector similarity, they need to be re-embedded using the current model. Consider adding a "Re-embed imported memories" prompt after import completes.

### Debug Export Enhancements
- Add retrieval scoring breakdown per-memory (why each memory was selected/rejected)
- Add timing breakdown for each retrieval pipeline stage

### Entity Card Bulk Actions
Similar to batch memory operations, but for entity graph nodes:
- Merge selected entities
- Delete selected entities (with edge cascade warning)

---

## Completed ✅

- [x] Contradiction detection (Tier 1: sentiment keywords)
- [x] LLM contradiction verification (Tier 2: custom API support)
- [x] Reranker support (Jina / local models)
- [x] Export/Import with merge/replace
- [x] Transient memory reclassification (heuristic + LLM)
- [x] Auto-hide with frozen reply support
- [x] Gap notice / narrative bridge for hidden messages
- [x] Entity context injection (separate budget from scene memory)
- [x] Post-history prompt injection
- [x] ST Vector Storage integration
- [x] Multi-profile backup failover for LLM calls
- [x] Abort signal support throughout extraction pipeline
- [x] Performance monitoring dashboard
- [x] Batch Memory Operations (bulk archive/unarchive/delete + filter-based "Archive All Matching")
- [x] LLM Contradiction Confidence Slider (UI control in side panel Settings tab)
