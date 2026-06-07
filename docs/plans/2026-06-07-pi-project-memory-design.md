# pi-project-memory — Design

**Date:** 2026-06-07
**Status:** Approved, ready for implementation
**Target:** A pi extension that maintains a per-project, multi-store semantic memory of the codebase, with auto-update and configurable models.

## 1. Goals & non-goals

**Goals**
- Give the agent durable understanding of the project across sessions, compactions, and `/new`.
- Auto-update memory as the agent works, without requiring explicit user action.
- Allow the user to configure multiple memory "stores" per repo (e.g. local project + shared platform).
- Allow per-store (and per-config-default) selection of the ingestion LLM and the embedding model.
- Make the on-disk representation human-readable markdown so the user can inspect, edit, and selectively commit it.
- Use sqlite-vec for fast semantic search; the vector index is derived, not authoritative.
- Be offline-friendly for the ingestion model (whatever pi has configured) and tolerant of missing embedding config (graceful degradation to keyword/Markdown-only search).

**Non-goals (YAGNI)**
- Cross-repo memory graph / shared knowledge base across many repos (a single store can live outside the repo, but we don't sync stores).
- Real-time filesystem watcher (we hook pi events instead — cheaper and more accurate to agent activity).
- UI for browsing the memory in pi (a TUI widget is tempting but out of scope; `cat` works).
- A custom vector DB or remote vector service (sqlite-vec only).
- Auto-commit of memory to git (the user controls git; we just write files).

## 2. High-level architecture

```
                ┌────────────────────────────────────────────────────┐
                │                   pi session                       │
                │                                                    │
   events ───►  │  ┌────────────────────────────────────────────┐    │
                │  │  pi-project-memory extension               │    │
                │  │                                            │    │
                │  │  ┌──────────────┐    ┌──────────────────┐  │    │
                │  │  │ IngestQueue  │───►│ IngestWorker     │  │    │
                │  │  │  (debounce)  │    │ (LLM call, write │  │    │
                │  │  └──────────────┘    │  markdown,       │  │    │
                │  │       ▲              │  re-embed)       │  │    │
                │  │       │              └──────────────────┘  │    │
                │  │       │                     │               │    │
                │  │  ┌────┴─────────┐   ┌───────▼──────────┐    │    │
                │  │  │Triggers:     │   │ StoreManager     │    │    │
                │  │  │ - tool_call  │   │  per-store:      │    │    │
                │  │  │ - turn_end   │   │   - markdown dir │    │    │
                │  │  │ - cmd        │   │   - vec.db       │    │    │
                │  │  └──────────────┘   │   - chunker      │    │    │
                │  │                     │   - embedder     │    │    │
                │  │                     └──────────────────┘    │    │
                │  │                                                │    │
                │  │  before_agent_start ──► ContextBuilder        │    │
                │  │  LLM tools ──────────► SearchEngine          │    │
                │  └────────────────────────────────────────────┘    │
                │                                                    │
                │  Ingestion LLM: pi-ai `complete()`                 │
                │  Embeddings: HTTP (OpenAI-compat) or Ollama        │
                └────────────────────────────────────────────────────┘
```

## 3. On-disk layout

Config is loaded from the first of these that exists (relative to repo root):

1. `./memory.config.json`
2. `./.pi/memory.json`

If neither exists, the extension runs in a default mode: a single store named `default` at `./.pi/memory/default/`, with ingestion using the active model and embeddings disabled (keyword search only).

Config schema:

```jsonc
{
  "version": 1,
  "defaults": {
    "ingestModel": "anthropic/claude-sonnet-4.5",     // optional, falls back to active model
    "embedding": {                                    // optional
      "provider": "openai-compatible",                // or "ollama"
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",                  // ${ENV} expansion
      "model": "text-embedding-3-small",
      "dimensions": 1536
    },
    "chunking": { "maxTokens": 600, "overlap": 80 },
    "ignore": ["node_modules", "dist", ".git", "build", "coverage", ".next", "out"],
    "maxFileBytes": 200000
  },
  "stores": [
    {
      "name": "project",
      "path": "./.pi/memory/project",
      "scope": "./",                                   // roots to scan for changes
      "include": ["**/*.ts", "**/*.md", "package.json", "tsconfig.json"],
      "ignore": ["**/*.test.ts", "**/__snapshots__/**"],
      "ingestModel": "anthropic/claude-sonnet-4.5",    // overrides defaults
      "embedding": { /* ... */ },                      // overrides defaults
      "chunking": { "maxTokens": 500, "overlap": 80 }
    },
    {
      "name": "platform",
      "path": "/Users/me/.memory/myorg-platform",
      "scope": "../",                                  // relative to config dir
      "include": ["**/*.md", "**/*.proto", "**/*.yaml"]
      // inherits defaults for ingestModel / embedding
    }
  ]
}
```

Per-store on disk:

```
<store path>/
  memory/
    architecture.md           # LLM-authored overview, always present
    modules/
      auth.md
      billing.md
      ...
    decisions/
      2026-05-12-jwt-refresh.md
    notes/
      gotchas.md
  index/
    vec.db                    # sqlite-vec database
    manifest.json             # chunk metadata, mtimes, hashes
  raw/                        # last seen project snapshot (for diffs in prompts)
    tree.txt
    files.json
```

The `raw/` snapshot is used to make ingestion prompts diff-aware ("here is what changed since the last ingestion"). The manifest tracks per-chunk hashes so we only re-embed what changed.

## 4. The ingestion model

### 4.1 Triggers

All triggers enqueue an `IngestJob { storeName, reason, changedFiles? }` into a debounced queue (default debounce 30s, configurable). One worker processes jobs serially per store; multiple stores run in parallel.

| Trigger | Source | Payload |
|---|---|---|
| File write/edit | `tool_call` for `write`/`edit` | `changedFiles: [absPath]` |
| Bulk file ops | `tool_call` for `bash` that touches many files | parsed from command (best-effort) |
| Turn boundary | `turn_end` | `changedFiles: [paths touched in this turn]` |
| Manual | `/memory refresh [store]` | `force: true` |
| Session start | `session_start` (reason `startup`/`new`) | `force: false`; ensures fresh memory after `/new` |

### 4.2 The ingestion prompt

Sent to the ingestion LLM:

```
SYSTEM: You maintain a structured memory of a software project. You will
receive (a) the current memory files for a store, (b) a list of files that
changed since the last ingestion, and (c) a snapshot of those files.

Produce a JSON object describing updates to the memory. You may create new
files, update existing ones, or leave them unchanged. Always produce
`architecture.md` as the canonical project overview; produce per-module
files only when a module is genuinely worth its own document.

Output format (strict JSON, no prose):
{
  "files": [
    { "path": "architecture.md", "content": "..." },
    { "path": "modules/auth.md", "content": "..." },
    { "path": "modules/billing.md", "delete": true }
  ],
  "summary": "One-line description of what changed."
}
```

The LLM is told it has read-only context, that paths are relative to the store's `memory/` directory, and that it should be **concise** (a hard cap of ~20K tokens of total memory per store, enforced by truncating per-file to 4K tokens and limiting the number of module files to 50).

### 4.3 Applying the result

1. Validate the JSON (schema check). On failure: log, keep the old memory, retry once with a stricter prompt, then surface a `notify` to the user.
2. Write each file atomically (write to `<path>.tmp` then rename). `delete: true` removes the file.
3. Re-embed only the files that actually changed (hash compare against manifest).
4. Update `manifest.json` with new mtime, hash, and chunk offsets.

### 4.4 Graceful degradation

- If ingestion LLM call fails: keep the last good memory, log, surface a non-blocking `notify` ("memory update failed: <reason>; using previous version").
- If embedding call fails: keep the markdown, mark the store as "no embeddings" — search falls back to keyword.
- If config file is malformed: extension refuses to load with a clear error message; does not crash the session.

## 5. The search model

### 5.1 Embeddings

Single embedding provider config in the config file. Per-store override is allowed.

Supported providers:
- `openai-compatible`: POST `{baseUrl}/embeddings` with `{ input, model }`, expects `{ data: [{ embedding: number[] }] }`. Works with OpenAI, vLLM, llama.cpp's server, etc.
- `ollama`: POST `{baseUrl}/api/embeddings` with `{ model, prompt }`, expects `{ embedding: number[] }`. Note: Ollama embeds one input at a time, so we batch with a small concurrency limit.

Batch size: 32 inputs per call for OpenAI-compat (most providers support this); 8 for Ollama.

The `dimensions` field must match the model. If sqlite-vec was built with a different dimension, we rebuild the index.

### 5.2 sqlite-vec schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(
  embedding float[<dimensions>]
);

CREATE TABLE IF NOT EXISTS chunk_meta (
  id          INTEGER PRIMARY KEY,
  store       TEXT NOT NULL,
  file        TEXT NOT NULL,        -- relative to store's memory/
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  hash        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_chunks_store ON chunk_meta(store);
```

Search query: `SELECT file, start_line, end_line, content FROM chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance` joined with `chunk_meta` filtered by store. If `embedding` is NULL (no provider configured), we fall back to:

```sql
SELECT file, start_line, end_line, content
FROM chunk_meta
WHERE store = ?
  AND (content LIKE ?1 OR content LIKE ?2 OR content LIKE ?3)
ORDER BY rank;  -- simple bm25 via FTS5 if present, else naive
```

We use FTS5 as the keyword fallback (always created, even when vec works) for the case of exact-token queries like function names.

### 5.3 Chunking

Markdown-aware chunker:
1. Split on H2 (`##`) headings, then merge small adjacent chunks.
2. If a section is still > `maxTokens`, split on H3, then on sentence boundaries.
3. Each chunk records its source line range.
4. Token estimate: `Math.ceil(chars / 4)` — good enough for embedding model context; we don't need exact BPE counts.

Code files use a simpler chunker: sliding window of `maxTokens` chars with `overlap`.

## 6. The user-facing surface

### 6.1 Tools registered with the LLM

| Tool | Args | Purpose |
|---|---|---|
| `memory_search` | `query: string, store?: string, limit?: number` | Semantic + keyword search across stores. Returns: store, file, line range, snippet, score. |
| `memory_read` | `path: string, store?: string` | Return raw markdown of a memory file. |
| `memory_write` | `path: string, content: string, store?: string` | Add/edit a memory entry directly. Goes through the same embedding pipeline. |
| `memory_refresh` | `store?: string` | Force ingestion now. |
| `memory_status` | `store?: string` | List stores, last update time, embedding provider, chunk count, total memory size. |

Each tool has a one-line `promptSnippet` and a `promptGuidelines` bullet so the LLM knows they exist.

### 6.2 Slash commands

| Command | Purpose |
|---|---|
| `/memory` | Show `memory_status` output. |
| `/memory refresh [store]` | Force ingestion. |
| `/memory search <query>` | Interactive search; shows top results in a TUI panel. |
| `/memory show <path>` | Print a memory file. |
| `/memory config` | Print resolved config (after env expansion). |

### 6.3 Automatic context injection

On `before_agent_start`:

1. If the prompt is trivial (length < 8 chars, or matches `/^(y|yes|no|ok|continue|go|sure|thanks|thank you|hi|hello)[.!]?$/i`), skip.
2. Compute the embedding of the prompt.
3. For each store, get top-2 chunks by similarity. Total budget: 1500 tokens.
4. Build a `<project_memory>` block and append to system prompt:

```
<project_memory stores="project, platform">
## project / architecture.md (L1-12)
[excerpt]
## platform / services/payments.md (L40-67)
[excerpt]
</project_memory>
```

If embeddings are unavailable, use the prompt's noun phrases (a simple regex) as keyword queries to FTS5.

### 6.4 Status footer

`ctx.ui.setStatus("memory", "memory: 3 stores, last 2m ago")` so the user can see the state at a glance.

## 7. Configuration: where things come from

Resolution order (first wins) for any setting:

1. CLI flag: `pi --memory-config /path/to/config.json`
2. `MEMORY_CONFIG` env var
3. `./memory.config.json`
4. `./.pi/memory.json`
5. Built-in defaults (single `default` store, no embeddings, active model for ingestion)

Environment variable expansion: any string value of the form `${VAR}` is replaced with `process.env.VAR`. Missing vars cause a clear error at load time.

Per-project config can be committed to git; per-user secrets (API keys) go through env expansion so the config file itself stays safe to commit.

## 8. Files in the extension

The extension lives in this repo, packaged as an npm-style extension (its own `package.json` + `node_modules`):

```
/home/pakky/projects/pi-project-memory/
├── package.json
├── README.md
├── src/
│   ├── index.ts                  # entry: extension factory, event wiring
│   ├── config.ts                 # config loading, validation, env expansion
│   ├── store.ts                  # StoreManager: per-store state
│   ├── markdown.ts               # markdown read/write atomic, chunker
│   ├── embeddings.ts             # provider abstraction (openai-compat, ollama)
│   ├── vec.ts                    # sqlite-vec schema, query helpers
│   ├── ingest/
│   │   ├── queue.ts              # debounced IngestQueue
│   │   ├── worker.ts             # one per store, runs ingestion
│   │   ├── prompt.ts             # builds ingestion prompt
│   │   ├── apply.ts              # validates LLM JSON, writes files
│   │   └── snapshot.ts           # builds the project snapshot (raw/)
│   ├── search.ts                 # search engine (vec + FTS5 fallback)
│   ├── context.ts                # before_agent_start injection
│   └── tools.ts                  # the five tools
├── tsconfig.json
└── docs/
    └── plans/
        └── 2026-06-07-pi-project-memory-design.md
```

Dependencies (`package.json`):
- `@earendil-works/pi-coding-agent` (peer, from pi's node_modules)
- `@earendil-works/pi-ai` (peer)
- `typebox` (peer, from pi)
- `better-sqlite3` — synchronous, simple, well-supported; sqlite-vec is officially compatible
- `sqlite-vec` — the extension load function
- (no embedding HTTP client — we use `fetch` from `node:undici`/built-in)

The extension's `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }` so it can be installed via `pi install` (npm path) or referenced directly from `~/.pi/agent/extensions/`.

## 9. Error handling & resilience

| Failure | Behavior |
|---|---|
| Config missing | Run in default mode (single `default` store, no embeddings). |
| Config malformed | Extension refuses to load; surface clear error. |
| Config refers to non-existent path | Create it on first write. |
| Ingest LLM call fails | Keep prior memory; `notify("memory update failed", "warning")`; retry once. |
| Ingest LLM returns invalid JSON | Reject, retry once with stricter prompt. |
| Embedding call fails | Mark store as "no embeddings"; keyword fallback. |
| sqlite-vec load fails (binary missing, etc.) | Fall back to FTS5-only search. |
| Disk write fails | Leave the old file in place; surface a `notify`. |
| Concurrent ingestion for same store | Queue serializes per-store jobs. |
| Process crash mid-write | Atomic writes (write to `.tmp` then rename) prevent partial files. |
| Memory grows too large | Hard cap: 20K tokens per store; oldest non-`architecture.md` files pruned first. |

## 10. Testing

- Unit tests for: config loader (env expansion, validation, defaults), markdown chunker, embedding provider abstraction with a stubbed `fetch`, vec schema migration, search with both backends.
- Integration tests using a temp dir + a fake LLM HTTP server (returns canned JSON) to drive the full ingest→embed→search flow.
- Manual smoke test: load the extension in pi, point it at a small real project, run `/memory refresh`, then `memory_search("how does auth work")` and verify results.
- A test fixture project under `tests/fixtures/sample-project/` with a known set of files and expected memory output.

## 11. Out of scope (deliberately deferred)

- Web UI / browser inspector for memory
- Sync between local and remote memory (e.g. S3, git remote)
- Re-ranking (cross-encoder, etc.) — embeddings-only at v1
- Incremental embeddings of massive monorepos (we cap at 20K tokens of memory per store)
- Multi-user / team memory sharing
- TUI widget for browsing memory (we surface results inline)

## 12. Open questions / future work

- Should we add a TUI browser for memory? Defer.
- Should we support `.pi/memory/**` git tracking helpers (e.g. `/memory commit`)? Defer.
- Should ingestion also have access to the agent's conversation history for context? Tempting, but out of scope for v1 to keep ingestion prompts focused on code state.
