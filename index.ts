/**
 * pi-project-memory — main extension entry point.
 *
 * When no memory.config.json exists: only the `memory_init` tool is available
 * to help the user set up project memory interactively.
 *
 * When a config is found: 5 tools + /memory command + auto-ingest/inject
 * are registered in session_start.
 *
 * The full toolset is registered only once (first session_start where stores exist).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadStores, type StoreConfigResolved, type MemoryConfig } from "./config.ts";
import { MemoryStore, type SearchResult } from "./store.ts";
import { MemoryIndexer } from "./indexer.ts";
import { createEmbeddingProvider, BatchEmbedder } from "./embedding.ts";
import { IngestionWorker, type LlmContext } from "./ingestion.ts";

interface StoreState {
  store: MemoryStore;
  indexer: MemoryIndexer;
  embedder: BatchEmbedder | null;
  config: StoreConfigResolved;
}

export default function (pi: ExtensionAPI) {
  let stores: Map<string, StoreState> = new Map();
  let worker: IngestionWorker | null = null;
  let currentModel: any = null;
  let currentModelAuth: { apiKey?: string; headers?: Record<string, string> } | null = null;
  let toolsRegistered = false;

  // Captured UI handle — persists across event handlers so background ingestion can show feedback
  let ui: {
    notify: (msg: string, level?: "info" | "warning" | "error") => void;
    setStatus: (id: string, status?: string) => void;
  } | null = null;

  // ─── Helpers ───────────────────────────────────────────

  function createLlmContext(): LlmContext {
    return {
      async complete(params) {
        let model = currentModel;
        let apiKey = currentModelAuth?.apiKey;
        let headers = currentModelAuth?.headers;

        if (params.model.id !== "active") {
          try {
            const { getModel } = await import("@earendil-works/pi-ai");
            const resolved = getModel(params.model.provider as any, params.model.id as any);
            if (resolved) {
              model = resolved;
              apiKey = params.apiKey || undefined;
              headers = undefined;
            }
          } catch { /* fallback to session model */ }
        }

        if (!model) {
          console.warn("[pi-project-memory] No model available for ingestion. Skipping.");
          return { content: '{"files":{}}' };
        }

        const { complete: piComplete } = await import("@earendil-works/pi-ai");
        const response = await piComplete(model, { messages: [
          { role: "system" as const, content: [{ type: "text" as const, text: params.systemPrompt }], timestamp: Date.now() },
          { role: "user" as const, content: [{ type: "text" as const, text: params.userPrompt }], timestamp: Date.now() },
        ]}, { apiKey, headers, signal: params.signal });

        return { content: response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n") };
      },
    };
  }

  async function initStores(cwd: string): Promise<void> {
    for (const [, s] of stores) s.store.close();
    stores.clear();

    const loaded = loadStores(cwd);
    if (loaded.length === 0) return;

    for (const cfg of loaded) {
      const store = new MemoryStore(cfg);
      await store.init();
      let embedder: BatchEmbedder | null = null;
      if (cfg.embedding) {
        const provider = createEmbeddingProvider(cfg.embedding);
        if (provider) embedder = new BatchEmbedder(provider);
      }
      stores.set(cfg.name, { store, indexer: new MemoryIndexer(store, embedder), embedder, config: cfg });
    }

    worker = new IngestionWorker(
      new Map(Array.from(stores.entries()).map(([n, s]) => [n, { store: s.store, indexer: s.indexer, config: s.config }])),
      createLlmContext, cwd, loaded[0]?.debounceMs ?? 30_000,
      (storeName, status, detail) => {
        if (!ui) return;
        // Clear any pending indicator once something happens
        ui.setStatus("memory:pending", undefined);
        const label = `memory:${storeName}`;
        if (status === "ingesting") {
          ui.setStatus(label, `🧠 ${detail ?? "ingesting..."}`);
        } else if (status === "complete") {
          ui.setStatus(label, undefined);
          ui.notify(`🧠 Memory updated: ${storeName} — ${detail ?? "done"}`, "info");
        } else if (status === "failed") {
          ui.setStatus(label, undefined);
          ui.notify(`🧠 Memory ingestion failed: ${storeName} — ${detail ?? "unknown error"}`, "warning");
        }
      },
    );

    for (const [, s] of stores) {
      if (await s.indexer.needsRebuild()) {
        const files = s.store.listRelativeFiles();
        if (files.length > 0) await s.indexer.reindex();
      }
    }
  }

  function activeStore(): string | null {
    return stores.size > 0 ? stores.keys().next().value ?? null : null;
  }

  // ─── memory_init — always available ──────────────────

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Set up project memory for this project. Creates a memory.config.json file.",
    promptSnippet: "Initialize project memory configuration",
    promptGuidelines: ["Use memory_init when the user wants to set up project memory or when no memory stores are available."],
    parameters: Type.Object({
      stores: Type.Array(Type.Object({
        name: Type.String({ description: "Name for this memory store (e.g. 'project', 'platform')" }),
        path: Type.Optional(Type.String({ description: "Path for the store (default: ./.pi/memory/<name>)" })),
      }), { description: "List of memory stores to create" }),
      embedding: Type.Optional(Type.Object({
        baseUrl: Type.String({ description: "Embedding service URL (e.g. http://localhost:11434/v1)" }),
        model: Type.String({ description: "Embedding model name (e.g. nomic-embed-text)" }),
        dimensions: Type.Number({ description: "Embedding dimensions (e.g. 768)" }),
      }), { description: "Optional embedding configuration for semantic search" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const storeList = params.stores as Array<{ name: string; path?: string }>;
      const embeddingCfg = params.embedding as { baseUrl: string; model: string; dimensions: number } | undefined;

      const config: MemoryConfig = {
        stores: storeList.map((s) => ({ name: s.name, path: s.path ?? `./.pi/memory/${s.name}` })),
      };
      if (embeddingCfg) {
        config.defaults = { embedding: { provider: "openai-compatible", baseUrl: embeddingCfg.baseUrl, model: embeddingCfg.model, dimensions: embeddingCfg.dimensions } };
      }

      const { writeFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const configPath = resolve(ctx.cwd, "memory.config.json");
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

      return {
        content: [{ type: "text" as const, text: `Created memory.config.json at ${configPath}\n\nStores: ${storeList.map((s) => s.name).join(", ")}\nEmbedding: ${embeddingCfg ? "configured" : "none (text search)"}\n\nRun memory_refresh() to start ingesting, or use memory_write() to add files manually.` }],
        details: { configPath },
      };
    },
  });

  // ─── Events ────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    // Capture UI handle for background ingestion feedback
    if (ctx.hasUI) {
      ui = {
        notify: (msg, level) => ctx.ui.notify(msg, level ?? "info"),
        setStatus: (id, status) => ctx.ui.setStatus(id, status),
      };
    }

    if (ctx.model) {
      currentModel = ctx.model;
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (auth.ok) currentModelAuth = { apiKey: auth.apiKey, headers: auth.headers };
      } catch {}
    }

    await initStores(ctx.cwd);

    if (stores.size > 0 && !toolsRegistered) {
      // ── Register the full toolset once stores exist ──

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
          const query = params.query as string;
          const storeNames = params.stores as string[] | undefined;
          const limit = (params.limit as number) ?? 5;
          const targetNames = storeNames ? storeNames.filter((n) => stores.has(n)) : Array.from(stores.keys());
          const all: SearchResult[] = [];
          for (const name of targetNames) {
            const state = stores.get(name);
            if (!state) continue;
            all.push(...(await state.indexer.search(query, limit)));
          }
          if (all.length === 0) return { content: [{ type: "text" as const, text: "No relevant memory found." }], details: {} };
          all.sort((a, b) => a.distance - b.distance);
          const formatted = all.slice(0, limit * targetNames.length).map((r, i) => {
            const ref = r.heading ? `${r.store}/${r.filePath} > ${r.heading}` : `${r.store}/${r.filePath}`;
            return `**${i + 1}. ${ref}** (lines ${r.startLine}-${r.endLine})\n${r.content}`;
          }).join("\n\n---\n\n");
          return { content: [{ type: "text" as const, text: formatted }], details: { count: all.length } };
        },
      });

      pi.registerTool({
        name: "memory_read",
        label: "Memory Read",
        description: "Read a specific memory file verbatim.",
        parameters: Type.Object({
          path: Type.String({ description: "File path relative to the memory store" }),
          store: Type.Optional(Type.String({ description: "Store name (default: first store)" })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const path = params.path as string;
          const storeName = (params.store as string) ?? activeStore();
          if (!storeName || !stores.has(storeName)) return { content: [{ type: "text" as const, text: `Store "${storeName}" not found.` }], details: {}, isError: true };
          const state = stores.get(storeName)!;
          const content = state.store.readFile(path);
          if (content === null) return { content: [{ type: "text" as const, text: `File "${path}" not found in "${storeName}".` }], details: {}, isError: true };
          return { content: [{ type: "text" as const, text: `## ${storeName}/${path}\n\n${content}` }], details: { store: storeName, path, size: content.length } };
        },
      });

      pi.registerTool({
        name: "memory_write",
        label: "Memory Write",
        description: "Write or update a memory file. Use this to record decisions, patterns, or any information about the project.",
        parameters: Type.Object({
          path: Type.String({ description: "File path relative to memory store (e.g. decisions.md)" }),
          content: Type.String({ description: "Markdown content to write" }),
          store: Type.Optional(Type.String({ description: "Store name (default: first store)" })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const path = params.path as string;
          const content = params.content as string;
          const storeName = (params.store as string) ?? activeStore();
          if (!storeName || !stores.has(storeName)) return { content: [{ type: "text" as const, text: `Store "${storeName}" not found.` }], details: {}, isError: true };
          const state = stores.get(storeName)!;
          state.store.writeFile(path, content);
          await state.indexer.indexFiles([path]);
          return { content: [{ type: "text" as const, text: `Written to ${storeName}/${path} (${content.length} chars) and re-indexed.` }], details: { store: storeName, path, size: content.length } };
        },
      });

      pi.registerTool({
        name: "memory_refresh",
        label: "Memory Refresh",
        description: "Force re-ingestion of the project state. Memory files are regenerated by analyzing the current codebase.",
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          if (!worker || stores.size === 0) return { content: [{ type: "text" as const, text: "No memory stores configured." }], details: {} };
          const results: string[] = [];
          for (const [name] of stores) {
            if (signal?.aborted) break;
            await worker.runIngestion(name);
            results.push(`${name}: ingested`);
          }
          return { content: [{ type: "text" as const, text: `Memory refresh complete:\n${results.map((r) => `  - ${r}`).join("\n")}` }], details: { results } };
        },
      });

      pi.registerTool({
        name: "memory_status",
        label: "Memory Status",
        description: "Show memory store status: stores loaded, file count, last updated, model info.",
        parameters: Type.Object({}),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          if (stores.size === 0) return { content: [{ type: "text" as const, text: "No memory stores configured." }], details: {} };
          const lines: string[] = [];
          for (const [name, state] of stores) {
            const files = state.store.listRelativeFiles();
            const lastIngested = state.store.getLastIngestedAt();
            const chunkCount = await state.indexer.chunkCount();
            const searchMode = state.embedder ? `semantic (${state.config.embedding?.provider}/${state.config.embedding?.model})` : "text (keyword)";
            lines.push(`### ${name}\n- Path: \`${state.config.path}\`\n- Memory files: ${files.length}\n- Indexed chunks: ${chunkCount}\n- Last ingested: ${lastIngested ?? "never"}\n- Search mode: ${searchMode}\n- Ingestion model: ${state.config.ingestionModel ?? "active (default)"}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details: { storeCount: stores.size, storeNames: Array.from(stores.keys()) } };
        },
      });

      // ── Commands ──
      pi.registerCommand("memory", {
        description: "Manage project memory. Subcommands: refresh, status, rebuild",
        handler: async (args, ctx) => {
          const parts = (args || "").trim().split(/\s+/);
          const subcmd = parts[0] || "status";
          if (stores.size === 0) { ctx.ui.notify("No memory stores configured", "warning"); return; }
          if (subcmd === "refresh") {
            ctx.ui.notify("Refreshing memory...", "info");
            for (const [name] of stores) await worker!.runIngestion(name);
            ctx.ui.notify("Memory refresh complete", "info");
          } else if (subcmd === "status") {
            const lines = ["Project Memory Status", ""];
            for (const [name, state] of stores) {
              const files = state.store.listRelativeFiles();
              const lastIngested = state.store.getLastIngestedAt();
              lines.push(`  ${name}:\n    Path: ${state.config.path}\n    Files: ${files.length}\n    Last ingested: ${lastIngested ?? "never"}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
          } else if (subcmd === "rebuild") {
            ctx.ui.notify("Rebuilding vector indexes...", "info");
            for (const [, state] of stores) await state.indexer.reindex();
            ctx.ui.notify("Vector indexes rebuilt", "info");
          } else {
            ctx.ui.notify(`Unknown: ${subcmd}. Use: refresh, status, rebuild`, "warning");
          }
        },
      });

      toolsRegistered = true;
    }
  });

  pi.on("model_select", async (event, ctx) => {
    currentModel = event.model;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(event.model);
      if (auth.ok) currentModelAuth = { apiKey: auth.apiKey, headers: auth.headers };
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    worker?.cancel();
    for (const [, s] of stores) s.store.close();
    stores.clear();
    currentModel = null;
    currentModelAuth = null;
    ui = null;
    toolsRegistered = false;
  });

  pi.on("turn_end", async (event) => {
    if (!worker || stores.size === 0) return;
    const tr = event.toolResults ?? [];
    if (!tr.some((t) => t.toolName === "write" || t.toolName === "edit" || t.toolName === "bash")) return;
    ui?.setStatus("memory:pending", `🧠 Changes detected — scheduling ingestion...`);
    for (const [name] of stores) worker.schedule(name);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (stores.size === 0) return;

    const storeNames = Array.from(stores.keys()).join(", ");
    let note = `\n\n## Project Memory\n\nYou have access to project memory:\n- \`memory_search(query)\` — search for relevant context\n- \`memory_read(path)\` — read a memory file\n- \`memory_write(path, content)\` — record notes or decisions\n- \`memory_status()\` — check loaded stores\n\nActive stores: ${storeNames}\n`;

    if (isSubstantive(event.prompt)) {
      try {
        const all: SearchResult[] = [];
        for (const [, state] of stores) { try { all.push(...(await state.indexer.search(event.prompt, 3))); } catch {} }
        if (all.length > 0) {
          all.sort((a, b) => a.distance - b.distance);
          const ctxLines = ["\n\n## Relevant Project Context\n", ...all.slice(0, 5).map((r) => {
            const ref = r.heading ? `${r.filePath} > ${r.heading}` : r.filePath;
            return `**${ref}** (lines ${r.startLine}-${r.endLine}):\n> ${r.content.slice(0, 200).replace(/\n/g, "\n> ")}`;
          })];
          note += ctxLines.join("\n\n");
        }
      } catch {}
    }
    return { systemPrompt: event.systemPrompt + note };
  });
}

// ─── Utility ────────────────────────────────────────────

function isSubstantive(prompt: string): boolean {
  const t = prompt.trim();
  if (t.length < 15) return false;
  return ![/^y(es)?$/i, /^ok(ay)?$/i, /^no$/i, /^\./, /^\//, /^[!?]/, /^thanks?$/i, /^done$/i, /^continue$/i, /^go( ahead)?$/i].some((p) => p.test(t));
}