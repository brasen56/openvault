What already exists (the load-bearing parts):

deleteMemory(id) in chat-data.js:158 already handles the ST Vector cleanup contract correctly (returns stChanges.toDelete for synced memories).
The UI wrapper in render.js:97 handles single-delete flow (apply stChanges → re-render → refresh stats).
archived: boolean is already in the schema (schemas.js:38) — so "soft remove for closed arcs" is partially scaffolded already; retrieval/IDF already filters on !m.archived.
Memory list already supports search + character filter, which gives you the selection vocabulary for "arc-based" cleanup.
What you'd need to add:

For batch hard-delete (1–2 hrs):

Selection mode toggle on the Memories tab → checkboxes on each card.
A deleteManyMemories(ids[]) repo method that loops deleteMemory, aggregates stChanges.toDelete into one array, and saves once at the end (single saveChatConditional rather than N).
Action bar (Select All / Delete Selected / Cancel) + a confirm modal (matches existing Emergency Cut modal pattern noted in ui/CLAUDE.md).
For arc-based / filter-based (the more useful version, ~2–3 hrs):
4. "Delete all matching current filter" button — uses the existing search/character filter as the selector. Shows count + confirm before firing.
5. Or even better: a bulkArchive(ids[]) that flips archived=true rather than deleting. This keeps the chat history-faithful, removes them from retrieval/injection, and is reversible. Since retrieval already respects archived, this is mostly UI work — the domain side is ~10 lines.

Recommendation: I'd build (5) first — bulk archive with filter-based selection — because it matches "arc is closed" semantics better than destruction, and the soft-delete plumbing is already in place. Hard batch delete can be added later as a second button if you find archive piles up too much.

---

Sketch: batch archive + batch delete
1. New store methods — src/store/chat-data.js

```
// Bulk archive (soft): just sets archived=true on each
export async function archiveMemories(ids) {
    const data = getOpenVaultData();
    if (!data) return { success: false, count: 0 };
    const set = new Set(ids);
    let count = 0;
    for (const m of data[MEMORIES_KEY] || []) {
        if (set.has(m.id) && !m.archived) {
            m.archived = true;
            count++;
        }
    }
    await getDeps().saveChatConditional();
    return { success: true, count };
}

// Bulk hard delete: aggregates stChanges, ONE save at the end
export async function deleteMemories(ids) {
    const data = getOpenVaultData();
    if (!data) return { success: false, count: 0 };
    const set = new Set(ids);
    const toDelete = [];
    const before = data[MEMORIES_KEY].length;

    data[MEMORIES_KEY] = data[MEMORIES_KEY].filter((m) => {
        if (!set.has(m.id)) return true;
        if (m._st_synced) toDelete.push({ hash: cyrb53(m.summary || '') });
        return false;
    });

    // Optional cascade: clean orphan source_ids on remaining reflections
    for (const m of data[MEMORIES_KEY]) {
        if (m.type === 'reflection') {
            if (m.source_ids) m.source_ids = m.source_ids.filter((id) => !set.has(id));
            if (m.parent_ids) m.parent_ids = m.parent_ids.filter((id) => !set.has(id));
        }
    }

    await getDeps().saveChatConditional();
    return {
        success: true,
        count: before - data[MEMORIES_KEY].length,
        stChanges: toDelete.length ? { toDelete } : undefined,
    };
}

// Reverse op (for archive)
export async function unarchiveMemories(ids) { /* same shape, flips false */ }
```

2. UI — src/ui/render.js
Add a "selection mode" state at the top of the file:

```
let selectionMode = false;
const selectedIds = new Set();
```

In renderMemoryItem(), when selectionMode is true, prepend a checkbox to each card (<input type="checkbox" class="ov-select" data-id="...">).

Add action bar above the list (toggle button + Archive Selected / Delete Selected / Cancel buttons). Bind once in bindMemoryListEvents() — they should be no-ops when selectedIds.size === 0.

Handler skeleton:

```
async function handleBulkArchive() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Archive ${ids.length} memories? (Reversible — they stay in the data but stop appearing in retrieval/injection.)`)) return;
    const res = await archiveMemories(ids);
    selectedIds.clear();
    renderMemoryList();
    refreshStats();
    showToast('success', `Archived ${res.count} memories`);
}

async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Permanently delete ${ids.length} memories? This cannot be undone.`)) return;
    const res = await deleteMemories(ids);
    if (res.stChanges) {
        const { applySyncChanges } = await import('../extraction/extract.js');
        await applySyncChanges(res.stChanges);
    }
    selectedIds.clear();
    renderMemoryList();
    populateCharacterFilter();
    refreshStats();
    showToast('success', `Deleted ${res.count} memories`);
}
```

For the "delete everything matching current filter" shortcut: grab the filtered list that renderMemoryList() already computes (render.js:84-94 is your filterMemories), then call archiveMemories(filtered.map(m => m.id)). That's basically a one-liner once the bulk methods exist.

3. Filter to hide archived (probably already there, double-check)
Memories tab should filter !m.archived by default with a "Show archived" toggle. Search render.js for archived — if it's not filtered in the UI, add it.

---

Don't try to decrement graph.nodes[].mentions or recompute edge weights on memory delete. It's not worth the complexity — the existing graph rebuild flows will eventually re-normalize, and inflated mentions don't break anything functionally, just visually.
Don't touch processed_messages — the user wanted the memory gone, not to re-extract.