/**
 * pi-project-memory — main extension entry point.
 *
 * Wires together:
 * - Config loading and store initialization
 * - Custom tools (memory_search, memory_read, memory_write, memory_refresh, memory_status)
 * - Commands (/memory)
 * - Event handlers (auto-ingest, auto-inject)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { complete, getModel } from "@earendil-works/pi-ai";

import { loadStores, type StoreConfigResolved } from "./config.ts";
import { MemoryStore } from "./store.ts";
import { MemoryIndexer } from "./indexer.ts";
import {
  createEmbeddingProvider,
  BatchEmbedder,
} from "./embedding.ts";
import { IngestionWorker, type LlmContext } from "./ingestion.ts";
import type { MemoryConfig } from "./config.ts";
import type { SearchResult } from "./store.ts";

interface StoreState {
  store: MemoryStore;
  indexer: MemoryIndexer;
  embedder: BatchEmbedder | null;
  config: StoreConfigResolved;
}

export default function (pi: ExtensionAPI) {
  let stores: Map<string, StoreState> = new Map();
  let config: MemoryConfig | null = null;
  let worker: IngestionWorker | null = null;
  let initialized = false;

  // ─── Helpers ───────────────────────────────────────────

  function createLlmContext(): LlmContext {
    return {
      async complete(params) {
        const modelId = params.model.id;
        const providerId = params.model.provider;

        const model = getModel(providerId as any, modelId as any);
        if (!model) {
          throw new Error(
            `Ingestion model not found: ${providerId}/${modelId}`,
          );
        }

        const messages = [
          {
            role: "system" as const,
            content: [{ type: "text" as const, text: params.systemPrompt }],
            timestamp: Date.now(),
          },
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: params.userPrompt }],
            timestamp: Date.now(),
          },
        ];

        const response = await complete(
          model,
          { messages },
          {
            apiKey: params.apiKey || undefined,
            signal: params.signal,
          },
        );

        const text = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        return { content: text };
      },
    };
  }

  function getActiveStore(ctx: {
    cwd: string;
    modelRegistry: any;
    model: any;
  }): string | null {
    if (stores.size === 0) return null;
    // Return first store as default
    return stores.keys().next().value ?? null;
  }

  function getStoreState(name: string): StoreState | undefined {
    return stores.get(name);
  }

  async function initializeStores(cwd: string): Promise<void> {
    // Close existing stores
    for (const [, state] of stores) {
      state.store.close();
    }
    stores.clear();

    config = null;

    // Load config
    const loadedConfig = loadStores(cwd);
    if (loadedConfig.length === 0) return;

    for (const cfg of loadedConfig) {
      const store = new MemoryStore(cfg);
      await store.init();

      let embedder: BatchEmbedder | null = null;
      if (cfg.embedding) {
        const provider = createEmbeddingProvider(cfg.embedding);
        if (provider) {
          embedder = new BatchEmbedder(provider);
        }
      }

      // Use a mock embedder if no real one configured (allows index to exist for testing)
      const be =
        embedder ??
        new BatchEmbedder(
          {
            embed: async (texts) =>
              texts.map(() => new Array(4).fill(0)),
            dimensions: 4,
          },
          20,
          1,
        );

      const indexer = new MemoryIndexer(store, be);

      stores.set(cfg.name, { store, indexer, embedder, config: cfg });
    }

    // Create ingestion worker
    worker = new IngestionWorker(
      new Map(
        Array.from(stores.entries()).map(([name, state]) => [
          name,
          { store: state.store, indexer: state.indexer, config: state.config },
        ]),
      ),
      createLlmContext,
      cwd,
      loadedConfig[0]?.debounceMs ?? 30_000,
      (storeName, status) => {
        // Could notify user here
      },
    );

    // Initial indexing: if stores have existing files but no vec index, build it
    for (const [name, state] of stores) {
      const needsBuild = await state.indexer.needsRebuild();
      if (needsBuild) {
        const files = state.store.listRelativeFiles();
        if (files.length > 0) {
          await state.indexer.reindex();
        }
      }
    }
  }

  // ─── Events ────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    await initializeStores(ctx.cwd);
    initialized = true;
  });

  pi.on("session_shutdown", async () => {
    worker?.cancel();
    for (const [, state] of stores) {
      state.store.close();
    }
    stores.clear();
    initialized = false;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!worker || stores.size === 0) return;

    // Check if any write/edit tool modified project files
    const toolResults = event.toolResults ?? [];
    let hasFileChanges = false;

    for (const tr of toolResults) {
      if (
        tr.toolName === "write" ||
        tr.toolName === "edit" ||
        tr.toolName === "bash"
      ) {
        hasFileChanges = true;
        break;
      }
    }

    if (!hasFileChanges) return;

    // Schedule ingestion for all stores
    for (const [name] of stores) {
      worker.schedule(name);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (stores.size === 0) return;

    // Append tool descriptions to system prompt
    let toolNote =
      "\n\n## Project Memory\n\nYou have access to project memory that helps you understand the codebase. Use these tools:\n";
    toolNote +=
      "- `memory_search(query)` — semantically search project memory for relevant context\n";
    toolNote +=
      "- `memory_read(path)` — read a specific memory file verbatim\n";
    toolNote +=
      "- `memory_write(path, content)` — record a note or decision for future reference\n";
    toolNote +=
      "- `memory_status()` — see which memory stores are loaded\n\n";
    toolNote += `Active stores: ${Array.from(stores.keys()).join(", ")}\n`;

    // Auto-inject context for substantive prompts
    if (
      isSubstantivePrompt(event.prompt) &&
      stores.size > 0
    ) {
      // Try to embed the prompt and find relevant context (best-effort)
      try {
        const allResults: SearchResult[] = [];
        for (const [, state] of stores) {
          if (state.embedder) {
            const results = await state.indexer.search(event.prompt, 3);
            allResults.push(...results);
          }
        }

        if (allResults.length > 0) {
          // Sort by distance (ascending = most similar)
          allResults.sort((a, b) => a.distance - b.distance);
          const topResults = allResults.slice(0, 5);

          const contextLines = [
            "\n\n## Relevant Project Context\n\nFrom your project memory:\n",
          ];
          for (const r of topResults) {
            const ref = r.heading
              ? `${r.filePath} > ${r.heading}`
              : r.filePath;
            contextLines.push(
              `**${ref}** (lines ${r.startLine}-${r.endLine}):\n> ${r.content.slice(0, 200).replace(/\n/g, "\n> ")}`,
            );
          }
          toolNote += contextLines.join("\n\n");
        }
      } catch {
        // Auto-inject failed silently — system prompt still gets tool descriptions
      }
    }

    return {
      systemPrompt: event.systemPrompt + toolNote,
    };
  });

  // ─── Tools ─────────────────────────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search project memory stores semantically. Returns relevant chunks with file:line references.",
    promptSnippet: "Search project memory for relevant context",
    promptGuidelines: [
      "Use memory_search when you need to understand project architecture, find relevant modules, or recall project decisions.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Natural language search query",
      }),
      stores: Type.Optional(
        Type.Array(
          Type.String({ description: "Store names to search (default: all)" }),
        ),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Results per store (default: 5)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const query = params.query as string;
      const storeNames = params.stores as string[] | undefined;
      const limit = (params.limit as number) ?? 5;

      const targetStores = storeNames
        ? storeNames.filter((n) => stores.has(n))
        : Array.from(stores.keys());

      const allResults: SearchResult[] = [];

      for (const name of targetStores) {
        const state = stores.get(name);
        if (!state?.embedder) continue;

        const results = await state.indexer.search(query, limit);
        allResults.push(...results);
      }

      if (allResults.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant memory found. Try a different query or use memory_status() to check which stores are loaded.",
            },
          ],
          details: {},
        };
      }

      // Sort by relevance
      allResults.sort((a, b) => a.distance - b.distance);

      const formatted = allResults
        .slice(0, limit * targetStores.length)
        .map((r, i) => {
          const ref = r.heading
            ? `${r.store}/${r.filePath} > ${r.heading}`
            : `${r.store}/${r.filePath}`;
          return `**${i + 1}. ${ref}** (lines ${r.startLine}-${r.endLine}, distance: ${r.distance.toFixed(4)})\n${r.content}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: formatted }],
        details: { resultCount: allResults.length },
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a specific memory file verbatim.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path relative to the memory store",
      }),
      store: Type.Optional(
        Type.String({
          description: "Store name (default: first configured store)",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = params.path as string;
      const storeName = (params.store as string) ?? getActiveStore(ctx);

      if (!storeName || !stores.has(storeName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Store "${storeName}" not found. Available stores: ${Array.from(stores.keys()).join(", ")}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const state = stores.get(storeName)!;
      const content = state.store.readFile(path);

      if (content === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `File "${path}" not found in store "${storeName}". Available files:\n${state.store.listRelativeFiles().map((f) => `  - ${f}`).join("\n")}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `## ${storeName}/${path}\n\n${content}`,
          },
        ],
        details: { store: storeName, path, size: content.length },
      };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Write or update a memory file. Use this to record decisions, patterns, or any information about the project.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path relative to memory store (e.g. decisions.md, modules/auth.md)",
      }),
      content: Type.String({
        description: "Markdown content to write",
      }),
      store: Type.Optional(
        Type.String({
          description: "Store name (default: first configured store)",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = params.path as string;
      const content = params.content as string;
      const storeName = (params.store as string) ?? getActiveStore(ctx);

      if (!storeName || !stores.has(storeName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Store "${storeName}" not found. Available stores: ${Array.from(stores.keys()).join(", ")}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const state = stores.get(storeName)!;
      state.store.writeFile(path, content);

      // Re-index just this file
      if (state.embedder) {
        await state.indexer.indexFiles([path]);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Written to ${storeName}/${path} (${content.length} chars) and re-indexed.`,
          },
        ],
        details: { store: storeName, path, size: content.length },
      };
    },
  });

  pi.registerTool({
    name: "memory_refresh",
    label: "Memory Refresh",
    description:
      "Force re-ingestion of the project state. Memory files are regenerated by analyzing the current codebase.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!worker || stores.size === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No memory stores configured. Create a memory.config.json or .pi/memory.json file.",
            },
          ],
          details: {},
        };
      }

      // Run ingestion for all stores immediately
      const results: string[] = [];
      for (const [name] of stores) {
        if (signal?.aborted) break;
        await worker.runIngestion(name);
        results.push(`${name}: ingested`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Memory refresh complete:\n${results.map((r) => `  - ${r}`).join("\n")}`,
          },
        ],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description:
      "Show memory store status: stores loaded, file count, last updated, model info.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (stores.size === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No memory stores configured. Create a memory.config.json or .pi/memory.json file.",
            },
          ],
          details: {},
        };
      }

      const lines: string[] = [];
      for (const [name, state] of stores) {
        const files = state.store.listRelativeFiles();
        const lastIngested = state.store.getLastIngestedAt();
        const chunkCount = await state.indexer.chunkCount();

        lines.push(`### ${name}`);
        lines.push(`- Path: \`${state.config.path}\``);
        lines.push(`- Memory files: ${files.length}`);
        lines.push(`- Indexed chunks: ${chunkCount}`);
        lines.push(
          `- Last ingested: ${lastIngested ?? "never"}`,
        );
        lines.push(
          `- Embedding: ${state.config.embedding ? `${state.config.embedding.provider}/${state.config.embedding.model}` : "none (no semantic search)"}`,
        );
        lines.push(
          `- Ingestion model: ${state.config.ingestionModel ?? "active (default)"}`,
        );

        if (files.length > 0) {
          lines.push("- Files:");
          for (const f of files) {
            lines.push(`  - \`${f}\``);
          }
        }
        lines.push("");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
        details: {
          storeCount: stores.size,
          storeNames: Array.from(stores.keys()),
        },
      };
    },
  });

  // ─── Commands ──────────────────────────────────────────

  pi.registerCommand("memory", {
    description:
      "Manage project memory. Subcommands: refresh, status, rebuild",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0] || "status";

      switch (subcmd) {
        case "refresh": {
          if (!worker || stores.size === 0) {
            ctx.ui.notify("No memory stores configured", "warning");
            return;
          }
          ctx.ui.notify("Refreshing memory...", "info");
          for (const [name] of stores) {
            await worker.runIngestion(name);
          }
          ctx.ui.notify("Memory refresh complete", "info");
          break;
        }

        case "status": {
          if (stores.size === 0) {
            ctx.ui.notify(
              "No memory stores configured. Create memory.config.json or .pi/memory.json",
              "warning",
            );
            return;
          }

          const lines: string[] = ["Project Memory Status", ""];
          for (const [name, state] of stores) {
            const files = state.store.listRelativeFiles();
            const lastIngested = state.store.getLastIngestedAt();
            lines.push(`  ${name}:`);
            lines.push(`    Path: ${state.config.path}`);
            lines.push(`    Files: ${files.length}`);
            lines.push(`    Last ingested: ${lastIngested ?? "never"}`);
            if (files.length > 0) {
              lines.push(`    Files: ${files.join(", ")}`);
            }
            lines.push("");
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "rebuild": {
          if (stores.size === 0) {
            ctx.ui.notify("No memory stores configured", "warning");
            return;
          }
          ctx.ui.notify("Rebuilding vector indexes...", "info");
          for (const [, state] of stores) {
            if (state.embedder) {
              await state.indexer.reindex();
            }
          }
          ctx.ui.notify("Vector indexes rebuilt", "info");
          break;
        }

        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcmd}. Use: refresh, status, rebuild`,
            "warning",
          );
      }
    },
  });
}

// ─── Utility ────────────────────────────────────────────

function isSubstantivePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 15) return false;

  // Skip simple affirmations, commands, single words
  const skipPatterns = [
    /^y(es)?$/i,
    /^ok(ay)?$/i,
    /^no$/i,
    /^\./,
    /^\//,
    /^[!?]/,
    /^thanks?$/i,
    /^done$/i,
    /^continue$/i,
    /^go( ahead)?$/i,
  ];

  for (const pattern of skipPatterns) {
    if (pattern.test(trimmed)) return false;
  }

  return true;
}