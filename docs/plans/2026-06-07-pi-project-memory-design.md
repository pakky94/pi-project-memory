# pi-project-memory Design

## Overview

A pi coding agent extension that maintains a persistent, searchable memory of software project structure. The agent automatically updates its understanding of the project as it works, without user intervention. Memory is stored as human-readable markdown files with a sqlite-vec vector index for semantic search.

## Goals

- Agent understands project architecture and can answer "where is X?" questions
- Memory updates automatically as the agent edits files and works on the project
- Human-readable markdown as the source of truth — no magic binary formats
- Semantic search via sqlite-vec for fuzzy recall
- Configurable per-project with support for multiple stores (e.g. local project + cross-repo architecture)
- Separate configurable LLM models for ingestion and embedding

## Non-goals

- Not a replacement for git — memory is derived from project state, not a version tracker
- Not a completion engine — memory is for the agent's understanding, not code generation
- Not a general RAG system — scoped to software project understanding
- No automatic `.gitignore` management — let the user decide what to commit

## Core Concepts

### Store

A `Store` is a named collection of project memory data. Each store has:

- A **unique name** (e.g. `"project"`, `"platform"`, `"infra"`)
- A **directory path** where its markdown files live
- An optional **sqlite-vec database** at `<path>/vec.db` (derived index)
- **Configurable ingestion** model and embedding endpoint
- **File patterns** for what to include/exclude when ingesting

Multiple stores let a single repository participate in different memory scopes simultaneously — e.g. a "project" store for the local service and a "platform" store shared across repos describing the larger architecture.

### Memory Config

A JSON file declaring stores and global defaults. Primary location is `memory.config.json` at the project root. Falls back to `.pi/memory.json` if the root file doesn't exist.

### Markdown Memory Files

Each store's directory contains markdown files written by the ingestion LLM. A typical layout:

```
<store-path>/
├── vec.db              # sqlite-vec index (auto-generated)
├── architecture.md     # Overall project structure
├── modules/
│   ├── auth.md         # Auth module details
│   ├── api.md          # API layer details
│   └── database.md     # Data access layer
└── decisions.md         # Architectural decisions made
```

The markdown files are git-friendly and human-readable. The vector DB is an accelerator derived from them.

## Configuration

### `memory.config.json` / `.pi/memory.json`

```json
{
  "$schema": "https://example.com/pi-memory-schema.json",

  "defaults": {
    "ingestionModel": "claude-sonnet-4-20250514",
    "embedding": {
      "provider": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "model": "nomic-embed-text",
      "apiKey": "",
      "dimensions": 768
    },
    "include": ["**/*.{ts,tsx,js,jsx,json,md,yaml,yml,toml}"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/.git/**"]
  },

  "stores": [
    {
      "name": "project",
      "path": "./.pi/memory/project"
    },
    {
      "name": "platform",
      "path": "/path/to/shared/architecture/memory"
    }
  ]
}
```

**Fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaults` | object | — | Global defaults applied to all stores |
| `defaults.ingestionModel` | string | active model | Provider/model ID for ingestion LLM calls |
| `defaults.embedding` | object | — | Embedding provider config |
| `defaults.embedding.provider` | string | `"openai-compatible"` | API format: `"openai-compatible"` or `"ollama"` |
| `defaults.embedding.baseUrl` | string | — | Embedding service URL |
| `defaults.embedding.model` | string | — | Embedding model name |
| `defaults.embedding.apiKey` | string | `""` | API key (can also use env var `EMBEDDING_API_KEY`) |
| `defaults.embedding.dimensions` | number | — | Embedding dimension count |
| `defaults.include` | string[] | `["**/*.{ts,tsx,js,jsx,json,md,yaml,yml,toml}"]` | Glob patterns for files to include in ingestion |
| `defaults.exclude` | string[] | `["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.pi/**"]` | Glob patterns to exclude |
| `defaults.autoinject` | boolean | `true` | Auto-inject relevant memory chunks for substantive prompts |
| `defaults.debounceMs` | number | `30000` | Debounce window for ingestion after changes (ms) |
| `stores` | array | `[]` | List of stores |
| `stores[].name` | string | — | Unique store name (required) |
| `stores[].path` | string | `./.pi/memory/<name>` | Directory for store markdown files |
| `stores[].ingestionModel` | string | global default | Override per store |
| `stores[].embedding` | object | global default | Override per store |
| `stores[].include` | string[] | global default | Override per store |
| `stores[].exclude` | string[] | global default | Override per store |

### Config Resolution

1. Look for `memory.config.json` in the project root (where pi was started / cwd)
2. If not found, look for `.pi/memory.json`
3. If neither exists, the extension loads silently with no active stores (agent just won't have memory tools)
4. Store `path` fields are resolved relative to the config file's directory

## Event-Driven Architecture

### Memory Update Flow

```
File edited (tool_call/tool_result)
         │
         ▼
Turn ends (turn_end)
         │
         ▼
Debounce (30s default) ──┬── timer fires ──┬── collect changed files
                         │                 │
                         ▼                 ▼
                  If debounce resets   ┌───┘
                  (new changes)        │
                         │             ▼
                         └──► No-op    Ingest job enqueued
                                           │
                                           ▼
                            ┌──────── Ingestion Worker ────────┐
                            │ 1. Snapshot project state        │
                            │    (package.json, tree, key src) │
                            │ 2. Read existing memory markdown │
                            │ 3. Call ingestion LLM:           │
                            │    "Here's current state +       │
                            │     existing memory. Update it." │
                            │ 4. Parse structured response     │
                            │ 5. Write updated markdown files  │
                            │ 6. Re-index changed files:       │
                            │    chunk → embed → store in vec  │
                            └─────────────────────────────────┘
```

### Query Flow (auto-inject)

```
User submits prompt
         │
         ▼
before_agent_start
    │
    ├─ Is prompt substantive? (length > 10 chars, not a command)
    │  └─ No → skip injection
    │
    ├─ Prompt substantive? ── Yes
    │   └─ Embed user prompt
    │      └─ Search all stores for top-K similar chunks
    │         └─ Format as markdown context block
    │            └─ Inject into system prompt or as a context message
    │
    └─ Append tool description to system prompt:
       "Use memory_search() and memory_read() for project context."
```

### Query Flow (on-demand tools)

```
LLM decides to call memory_search("auth module")
         │
         ▼
Embed "auth module" → search each store's vec.db → return chunks
         │
         ▼
Return formatted result with file:line references and store name
```

## Data Flow

### Ingestion LLM Call

The ingestion worker sends to the configured LLM:

```
System: You are a project documentation writer.
Your job is to maintain a concise markdown memory of a software project.

Current project root:
<list of files and directories>

Existing memory files:
<content of architecture.md, etc.>

Recent changes (files that were edited):
<diff or file contents for changed files>

Task: Update the memory files to reflect the current state.
Respond with a JSON object mapping file paths to their new markdown content.
Only include files that need changes.
```

### Chunking for Embedding

Each markdown file is split into chunks using a strategy appropriate for markdown:

1. Split on `##` and `###` headings (section-level chunks)
2. If a section exceeds 512 tokens, further split on paragraphs
3. Each chunk is stored with:
   - `store` — store name
   - `file` — file path relative to store path
   - `heading` — section heading (for context)
   - `start_line` / `end_line` — line range in the file
   - `text` — the chunk text
   - `embedding` — the vector (F32 BLOB)

### Embedding API Call

For each chunk, the extension calls the configured embedding endpoint:

```
POST <baseUrl>/embeddings
Content-Type: application/json
Authorization: Bearer <apiKey>

{
  "model": "nomic-embed-text",
  "input": "chunk text here"
}

Response:
{
  "data": [{
    "embedding": [0.123, -0.456, ...]
  }]
}
```

## Schema (sqlite-vec)

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL,
  file_path TEXT NOT NULL,
  heading TEXT,
  start_line INTEGER,
  end_line INTEGER,
  content TEXT NOT NULL
);

CREATE TABLE vec_chunks (
  id INTEGER PRIMARY KEY REFERENCES chunks(id),
  embedding FLOAT32[dimensions]
);

-- Metadata for cache invalidation
CREATE TABLE store_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

## Extension Tools

### `memory_search(query, stores?, limit?)`
Semantic search across memory stores.

- **query**: natural language search string
- **stores** (optional): array of store names to search (default: all)
- **limit** (optional): results per store (default: 5)
- **Returns**: list of chunks with store, file, lines, content, similarity score

### `memory_read(path)`
Read a specific memory file verbatim.

- **path**: path relative to the active store (e.g. `"architecture.md"`)
- **Returns**: full file content with store name

### `memory_write(path, content)`
Write/update a memory file.

- **path**: path relative to the active store
- **content**: markdown content to write
- **Returns**: confirmation with file path

### `memory_refresh()`
Force re-ingestion of the project state.

- **Returns**: status of the ingestion job

### `memory_status()`
Show memory store status.

- **Returns**: list of stores with file count, last updated, model info

## Extension Events

### `turn_end` handler
Debounced trigger for ingestion. Detects whether relevant files were modified during the turn.

### `before_agent_start` handler
Auto-injects memory context for substantive prompts. Appends tool descriptions to system prompt.

### `session_start` handler
Loads config and initializes stores. Builds vector index if missing.

### `session_shutdown` handler
Clean shutdown of any pending ingestion jobs.

## Commands

### `/memory refresh`
Force re-ingestion.

### `/memory status`
Display store status in TUI.

### `/memory rebuild`
Drop and rebuild all vector indexes from markdown files.

## Dependencies

- `sqlite-vec` — SQLite vector extension (npm package)
- Uses Node.js built-in `node:sqlite` (available in Node 24+; polyfill via `better-sqlite3` if needed)

No heavy dependencies. Embedding is done via plain `fetch()` to the configured HTTP endpoint.

## Error Handling

- **Config errors**: Store fails to load → log warning, continue without that store, notify user once
- **Embedding failure**: Retry once after 2s; if still fails, skip embedding for that chunk, log warning; use zero-vector placeholder
- **Ingestion LLM failure**: Retry once; if still fails, skip this ingestion cycle; mark as needing refresh
- **sqlite-vec load failure**: Degrade gracefully — markdown files still work, memory tools still work, semantic search returns "not available"
- **Concurrent ingestion**: Lock with a simple in-memory flag per store; skip duplicate if already running