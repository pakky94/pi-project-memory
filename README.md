# pi-project-memory

A [pi coding agent](https://github.com/pakky94/pi-coding-agent) extension that maintains persistent, searchable memory of your software projects. The agent automatically updates its understanding of the project as it works, without user intervention.

Memory is stored as human-readable markdown files with an optional sqlite-vec vector index for semantic search.

## Features

- **Persistent markdown memory** — architecture, modules, decisions, patterns. Human-readable, git-friendly.
- **Semantic search** — optional embedding provider (OpenAI-compatible or Ollama) for vector search. Falls back to keyword search when no embedding is configured.
- **Auto-updates** — after file edits/writes, the extension debounces an LLM-based ingestion to keep memory current.
- **Auto-inject** — for substantive prompts, relevant memory chunks are injected into context automatically.
- **Multiple stores** — configure multiple memory scopes per project (e.g. `project`, `platform`, `infra`).
- **Configurable ingestion model** — use a separate LLM for memory generation, or default to the session's active chat model.

## Installation

### From GitHub (global)

```bash
pi install git:github.com/pakky94/pi-project-memory
```

### From local clone

```bash
pi install /path/to/pi-project-memory
```

The extension auto-loads on every pi session after installation.

## Configuration

Create a `memory.config.json` at your project root (or `.pi/memory.json` as fallback):

### Minimal (text-only search, no embedding)

```json
{
  "stores": [
    {
      "name": "project",
      "path": "./.pi/memory/project"
    }
  ]
}
```

### With embedding (semantic search)

```json
{
  "stores": [
    {
      "name": "project",
      "path": "./.pi/memory/project"
    }
  ],
  "defaults": {
    "embedding": {
      "provider": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "model": "nomic-embed-text",
      "dimensions": 768
    }
  }
}
```

### Multiple stores + separate ingestion model

```json
{
  "stores": [
    {
      "name": "project",
      "path": "./.pi/memory/project"
    },
    {
      "name": "platform",
      "path": "/path/to/shared/platform-memory"
    }
  ],
  "defaults": {
    "ingestionModel": "anthropic/claude-sonnet-4-20250514",
    "embedding": {
      "provider": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "model": "nomic-embed-text",
      "dimensions": 768
    }
  }
}
```

### All configuration options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaults.ingestionModel` | string | active session model | Provider/model for memory generation LLM |
| `defaults.embedding.provider` | string | `"openai-compatible"` | `"openai-compatible"` or `"ollama"` |
| `defaults.embedding.baseUrl` | string | — | Embedding service URL |
| `defaults.embedding.model` | string | — | Embedding model name |
| `defaults.embedding.dimensions` | number | — | Embedding vector dimensions |
| `defaults.autoinject` | boolean | `true` | Auto-inject relevant memory for substantive prompts |
| `defaults.debounceMs` | number | `30000` | Debounce window after file changes (ms) |
| `defaults.include` | string[] | Source files | Glob patterns for files to analyze during ingestion |
| `defaults.exclude` | string[] | Build artifacts | Glob patterns to ignore |
| `stores[].name` | string | — | **Required.** Unique store identifier |
| `stores[].path` | string | `./.pi/memory/<name>` | Directory for store's markdown files |

## Usage

### Getting started

If no `memory.config.json` exists, only one tool is available:

- **`memory_init(stores, embedding?)`** — creates `memory.config.json` with your store names and optional embedding config

Once a config is present, the full toolset loads on the next session start.

### Tools

| Tool | Description |
|------|-------------|
| `memory_search(query, stores?, limit?)` | Semantic or keyword search across memory stores |
| `memory_read(path, store?)` | Read a specific memory file verbatim |
| `memory_write(path, content, store?)` | Write/update a memory file (auto re-indexes) |
| `memory_refresh()` | Force LLM-based re-ingestion of the project |
| `memory_status()` | Show store stats (files, chunks, last ingested, search mode) |

### Commands

- **`/memory refresh`** — force re-ingestion
- **`/memory status`** — display store status
- **`/memory rebuild`** — drop and rebuild vector indexes from existing markdown files

### What happens automatically

- After file edits/writes → debounced ingestion scheduled (30s default)
- On substantive prompts → relevant memory chunks auto-injected into context
- Tool descriptions appended to system prompt
- Config auto-discovered from `memory.config.json` or `.pi/memory.json`

## How it works

### Architecture

```
memory.config.json ──► loadStores() ──► Store[]
                                            │
                      ┌─────────────────────┤
                      ▼                     ▼
                 MemoryStore            MemoryIndexer
              (.md files + DB)     (chunk → embed → vec0)
                      │                     │
                      └─────────┬───────────┘
                                ▼
                        IngestionWorker
                    (debounced LLM-based)
```

- **Markdown files** (`.pi/memory/project/*.md`) are the human-readable source of truth
- **sqlite-vec** provides the vector index for semantic search when embedding is configured
- When no embedding is configured, `memory_search()` falls back to keyword (LIKE) matching
- The ingestion LLM reads the project tree + key files + existing memory, then produces updated markdown files as structured JSON

## Development

The extension lives in a single directory:

```
pi-project-memory/
├── index.ts         # Entry point — tools, events, commands
├── config.ts        # Config loading and resolution
├── store.ts         # MemoryStore — files + sqlite-vec DB
├── indexer.ts       # MemoryIndexer — chunk, embed, search
├── embedder.ts      # Embedding providers (OpenAI, Ollama)
├── ingestion.ts     # IngestionWorker — LLM-based ingestion
├── files.ts         # File discovery with glob patterns
├── prompts.ts       # Ingestion LLM prompts
├── chunker.ts       # Markdown chunking (heading-aware)
├── memory.config.json  # This project's own memory config
└── package.json     # Dependencies
```

### Dependencies

- `sqlite-vec` — SQLite vector extension
- `minimatch` — Glob pattern matching
- Node.js 24+ built-in `node:sqlite`