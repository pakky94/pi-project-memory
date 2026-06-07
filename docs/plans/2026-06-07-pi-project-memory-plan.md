# pi-project-memory Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build a pi extension that automatically builds and maintains a searchable project memory from markdown files with sqlite-vec semantic search.

**Architecture:** Multi-file extension in `~/.pi/agent/extensions/pi-project-memory/` with npm dependencies (sqlite-vec, minimatch). A config file at `memory.config.json` or `.pi/memory.json` declares stores (named memory scopes). Each store has markdown files + a sqlite-vec DB. An ingestion LLM writes the markdown; an embedding endpoint indexes chunks for semantic search. Tools let the LLM query memory; event handlers auto-trigger ingestion and auto-inject context.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent`, `sqlite-vec` (npm), `node:sqlite` (Node 24+), `node:fs`, `minimatch` for glob matching

---

### Task 1: Project scaffold and config loading

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/package.json`
- Create: `~/.pi/agent/extensions/pi-project-memory/config.ts`
- Test: verify extension loads via `pi` and config is read from a test config file

**Step 1: Create the extension directory and package.json**

```json
{
  "name": "pi-project-memory",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "sqlite-vec": "^0.1.8",
    "minimatch": "^10.0.1"
  }
}
```

**Step 2: Write config.ts**

Types and loader for `MemoryConfig`. Two fields: `defaults` and `stores[]`. Resolution order: cwd/memory.config.json → cwd/.pi/memory.json → empty config.

```typescript
// Core types
export interface EmbeddingConfig {
  provider?: "openai-compatible" | "ollama";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dimensions?: number;
}

export interface StoreConfig {
  name: string;
  path?: string;
  ingestionModel?: string;
  embedding?: EmbeddingConfig;
  include?: string[];
  exclude?: string[];
}

export interface MemoryConfig {
  defaults?: {
    ingestionModel?: string;
    embedding?: EmbeddingConfig;
    include?: string[];
    exclude?: string[];
    autoinject?: boolean;
    debounceMs?: number;
  };
  stores?: StoreConfig[];
}

export function loadConfig(cwd: string): MemoryConfig;
export function resolveStorePath(configDir: string, store: StoreConfig): string;
```

**Step 3: Verify extension loads**

```bash
cd /tmp/test-project && pi -m "hello" -e ~/.pi/agent/extensions/pi-project-memory
```

Expected: extension loads without error (even with no config, runs silently).

---

### Task 2: Store class and sqlite-vec database initialization

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/store.ts`
- Create: `~/.pi/agent/extensions/pi-project-memory/schema.sql`
- Test: unit test that creates a store, inits DB, writes meta, reads it back

**Step 1: Create Store class**

```typescript
export class MemoryStore {
  name: string;
  basePath: string;
  dbPath: string;
  config: StoreConfigResolved;
  
  constructor(name: string, basePath: string, config: StoreConfigResolved);
  
  // Initialize (create dir, init DB)
  async init(): Promise<void>;
  
  // DB access
  getDb(): DatabaseSync;
  
  // List memory files
  listFiles(): string[];
  
  // Read a memory file
  readFile(relativePath: string): string | null;
  
  // Write a memory file
  writeFile(relativePath: string, content: string): void;
  
  // Get store meta
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
```

**Step 2: sqlite-vec init**

```typescript
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

function initDatabase(db: DatabaseSync, dimensions: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      heading TEXT,
      start_line INTEGER,
      end_line INTEGER,
      content TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS vec_chunks (
      id INTEGER PRIMARY KEY REFERENCES chunks(id),
      embedding FLOAT32[${dimensions}]
    );
    
    CREATE TABLE IF NOT EXISTS store_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
```

**Step 3: Validation**

```bash
# We'll test this by writing a small test script that creates a store
# and verifies the DB exists with correct tables
cd ~/.pi/agent/extensions/pi-project-memory && node -e "
  import { MemoryStore } from './store.ts';
  const s = new MemoryStore('test', '/tmp/test-memory', { ... });
  await s.init();
  console.log('Store OK');
"
```

---

### Task 3: Markdown chunking utility

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/chunker.ts`
- Test: verify chunking on sample markdown

**Step 1: Write chunker**

```typescript
export interface Chunk {
  filePath: string;
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

// Split markdown into chunks by heading boundaries
export function chunkMarkdown(markdown: string, filePath: string, maxTokens?: number): Chunk[];
```

Strategy:
1. Split on `## ` and `### ` headings
2. For sections > 512 token estimate (chars / 4), split on paragraph breaks
3. Assign heading hierarchy to each chunk
4. Track line numbers for file:line references

**Step 2: Test with sample**

```typescript
// Input
// # Architecture
// ## API Layer
// The API layer handles HTTP requests...
// ## Database
// The database layer...

// Expected: 2 chunks, one for "API Layer", one for "Database"
```

---

### Task 4: Embedding service

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/embedding.ts`
- Test: confirm the HTTP call is structured correctly (dry-run against a real endpoint)

**Step 1: Write embedding client**

```typescript
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider;
```

Supports `openai-compatible` format (POST /v1/embeddings, body {model, input}, returns {data[{embedding}]}) and `ollama` format (POST /api/embed, body {model, input}, returns {embeddings[]}).

**Step 2: Batch embedding with retry**

- Batch up to 20 texts per call
- Add exponential backoff on failure
- Log warnings on failure, return zero vectors as fallback

---

### Task 5: Indexer (markdown → chunks → embeddings → sqlite-vec)

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/indexer.ts`
- Test: write a memory file, index it, search it

**Step 1: Write indexer class**

```typescript
export class MemoryIndexer {
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingProvider
  ) {}
  
  // Re-index all markdown files in the store
  async reindex(): Promise<void>;
  
  // Index specific files (incremental update)
  async indexFiles(filePaths: string[]): Promise<void>;
  
  // Search across this store's index
  async search(query: string, limit?: number): Promise<SearchResult[]>;
}
```

**Step 2: Build search**

1. Embed the query string
2. Execute sqlite-vec query: `SELECT c.*, distance FROM chunks c JOIN vec_chunks v ON c.id = v.id WHERE v.embedding MATCH ? ORDER BY distance LIMIT ?`
3. Return formatted results

---

### Task 6: Ingestion worker (LLM-based)

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/ingestion.ts`
- Create: `~/.pi/agent/extensions/pi-project-memory/prompts.ts`
- Test: mock LLM response, verify markdown files are written

**Step 1: Write prompts**

```typescript
export function buildIngestionPrompt(params: {
  projectRoot: string;
  fileTree: string;
  existingMemory: Map<string, string>;
  recentChanges: string;
  includePatterns: string[];
  excludePatterns: string[];
}): { system: string; user: string };
```

The prompt instructs the LLM to:
1. Read the current project tree and key files
2. Read existing memory files
3. Produce updated markdown files as JSON: `{ "files": { "architecture.md": "...", "modules/auth.md": "...", "decisions.md": "..." } }`
4. Only include files that changed

**Step 2: Write ingestion worker**

```typescript
export class IngestionWorker {
  private isRunning = false;
  private pendingStore: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  constructor(
    private stores: Map<string, { store: MemoryStore; indexer: MemoryIndexer; embedder: EmbeddingProvider }>,
    private getIngestionModel: () => { model: any; apiKey: string; headers: Record<string,string> },
    private cwd: string
  ) {}
  
  // Schedule an ingestion for a store (debounced)
  schedule(storeName: string): void;
  
  // Run ingestion now for a specific store
  async runIngestion(storeName: string): Promise<void>;
  
  // Cancel pending
  cancel(): void;
}
```

**Step 3: readKeyFiles helper**

```typescript
// Find top-level files matching include patterns, plus key markers
export async function readKeyFiles(
  cwd: string,
  include: string[],
  exclude: string[]
): Promise<{ tree: string; files: Map<string, string> }>;
```

Uses `fast-glob` or a simple recursive find with `minimatch` patterns.

---

### Task 7: Extension entry point — tools registration

**Files:**
- Create: `~/.pi/agent/extensions/pi-project-memory/index.ts`
- Modify: `~/.pi/agent/extensions/pi-project-memory/package.json`
- Test: start pi, verify tools appear and are callable

**Step 1: Register custom tools**

```typescript
export default function (pi: ExtensionAPI) {
  // Load config from cwd
  // Initialize stores
  // Initial ingestion (if no markdown files exist)
  
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search project memory stores semantically. Returns relevant chunks with file:line references.",
    promptSnippet: "Search project memory for relevant context",
    promptGuidelines: ["Use memory_search when you need to understand project architecture, find relevant modules, or recall project decisions."],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      stores: Type.Optional(Type.Array(Type.String({ description: "Store names to search (default: all)" }))),
      limit: Type.Optional(Type.Number({ description: "Results per store (default: 5)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Search all stores, aggregate results
    },
  });
  
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a specific memory file verbatim.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to memory store" }),
      store: Type.Optional(Type.String({ description: "Store name (default: first store)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Read and return file content
    },
  });
  
  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Write or update a memory file. Use this to record decisions, patterns, or any information the agent should remember.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to memory store" }),
      content: Type.String({ description: "Markdown content to write" }),
      store: Type.Optional(Type.String({ description: "Store name (default: first store)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Write file and re-index it
    },
  });
  
  pi.registerTool({
    name: "memory_refresh",
    label: "Memory Refresh",
    description: "Force re-ingestion of the project state. Memory files are regenerated by analyzing the current codebase.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Trigger ingestion
    },
  });
  
  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show memory store status: stores loaded, file count, last updated timestamp, model info.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Return formatted status
    },
  });
}
```

**Step 2: Verify tools load**

```bash
pi -e ~/.pi/agent/extensions/pi-project-memory --prompt "call memory_status" -s
```

---

### Task 8: Event handlers — auto-update and auto-inject

**Files:**
- Modify: `~/.pi/agent/extensions/pi-project-memory/index.ts`
- Create: `~/.pi/agent/extensions/pi-project-memory/events.ts`
- Test: simulate tool calls and verify ingestion is scheduled

**Step 1: Write event handlers**

```typescript
export function registerEventHandlers(
  pi: ExtensionAPI,
  worker: IngestionWorker,
  stores: Map<string, StoreState>,
  config: MemoryConfig
): void {
  
  // session_start: load config, init stores
  pi.on("session_start", async (event, ctx) => {
    // Reload config (project may have changed)
    // Initialize or re-initialize stores
    // Check if initial ingestion needed (no memory files exist → ingest)
  });
  
  // turn_end: check if files were modified, schedule ingestion
  pi.on("turn_end", async (event, ctx) => {
    // Look at tool results for file modifications
    // If files matching include patterns were edited → schedule ingestion
  });
  
  // before_agent_start: inject memory context
  pi.on("before_agent_start", async (event, ctx) => {
    if (config.defaults?.autoinject !== false && isSubstantive(event.prompt)) {
      // Embed the user prompt
      // Search for top-N chunks across all stores
      // Format as project memory context block
      // Append to system prompt
    }
    // Also append tool descriptions
    return {
      systemPrompt: event.systemPrompt + "\n\n" + getMemoryPromptSnippet()
    };
  });
  
  // session_shutdown: cleanup
  pi.on("session_shutdown", async (event, ctx) => {
    worker.cancel();
  });
}
```

**Step 2: Substantive prompt detection**

```typescript
function isSubstantive(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 10) return false;
  // Skip simple affirmations and commands
  const skipPatterns = ["^y$", "^yes", "^ok", "^no", "^\\.", "^/"];
  for (const p of skipPatterns) {
    if (new RegExp(p, "i").test(trimmed)) return false;
  }
  return true;
}
```

---

### Task 9: Commands — /memory

**Files:**
- Modify: `~/.pi/agent/extensions/pi-project-memory/index.ts`
- Test: manual verification via pi's TUI

```typescript
pi.registerCommand("memory", {
  description: "Manage project memory. Subcommands: refresh, status, rebuild",
  handler: async (args, ctx) => {
    const parts = (args || "").trim().split(/\s+/);
    const subcmd = parts[0] || "status";
    
    switch (subcmd) {
      case "refresh":
        // Force ingestion
        break;
      case "status":
        // Show store status in UI
        break;
      case "rebuild":
        // Drop and rebuild vector indexes
        break;
      default:
        ctx.ui.notify(`Unknown subcommand: ${subcmd}. Use: refresh, status, rebuild`, "warning");
    }
  },
});
```

---

### Task 10: npm install and end-to-end test

**File:** ~/.pi/agent/extensions/pi-project-memory/package.json (ensure deps installed)

**Step 1: Install deps**

```bash
cd ~/.pi/agent/extensions/pi-project-memory && npm install
```

**Step 2: Create a test project with a memory.config.json**

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

**Step 3: Start pi in the test project and verify**

```bash
cd /tmp/test-project && pi
# /memory status → shows "project" store
# memory_search tool appears in tool list
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: initial working extension with config, stores, tools, events"
```