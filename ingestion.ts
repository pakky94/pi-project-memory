/**
 * Ingestion worker — orchestrates the LLM-based ingestion flow.
 *
 * Flow:
 * 1. Discover project files matching include/exclude patterns
 * 2. Read existing memory files
 * 3. Call ingestion LLM to produce updated markdown
 * 4. Parse the JSON response and write files
 * 5. Re-index changed files
 */

import type { MemoryStore } from "./store.ts";
import type { MemoryIndexer } from "./indexer.ts";
import type { BatchEmbedder } from "./embedding.ts";
import { discoverFiles, getProjectTree, type FileEntry } from "./files.ts";
import {
  buildIngestionSystemPrompt,
  buildIngestionUserPrompt,
} from "./prompts.ts";
import type { StoreConfigResolved } from "./config.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Callback type for making an LLM completion call.
 * The extension provides this since it depends on pi's model registry.
 */
export interface LlmCallParams {
  model: {
    id: string;
    provider: string;
  };
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

/**
 * The execution context for making LLM calls, provided by the extension.
 */
export interface LlmContext {
  complete(
    params: LlmCallParams,
  ): Promise<{ content: string }>;
}

/**
 * An ingestion response from the LLM.
 */
interface IngestionResponse {
  files: Record<string, string>;
}

export class IngestionWorker {
  private _isRunning: boolean = false;
  private _pendingStore: string | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _stores: Map<
    string,
    { store: MemoryStore; indexer: MemoryIndexer; config: StoreConfigResolved }
  >;
  private _getLlmContext: () => LlmContext;
  private _cwd: string;
  private _debounceMs: number;
  private _onStatusChange?: (store: string, status: string) => void;

  constructor(
    stores: Map<
      string,
      {
        store: MemoryStore;
        indexer: MemoryIndexer;
        config: StoreConfigResolved;
      }
    >,
    getLlmContext: () => LlmContext,
    cwd: string,
    debounceMs: number = 30_000,
    onStatusChange?: (store: string, status: string) => void,
  ) {
    this._stores = stores;
    this._getLlmContext = getLlmContext;
    this._cwd = cwd;
    this._debounceMs = debounceMs;
    this._onStatusChange = onStatusChange;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Schedule an ingestion for a store (debounced).
   */
  schedule(storeName: string): void {
    this._pendingStore = storeName;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      if (this._pendingStore) {
        const name = this._pendingStore;
        this._pendingStore = null;
        this.runIngestion(name).catch((err) => {
          console.warn(
            `[pi-project-memory] Ingestion failed for "${name}":`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }, this._debounceMs);
  }

  /**
   * Run ingestion immediately for a specific store.
   */
  async runIngestion(storeName: string): Promise<void> {
    const entry = this._stores.get(storeName);
    if (!entry) {
      console.warn(
        `[pi-project-memory] Store "${storeName}" not found for ingestion`,
      );
      return;
    }

    if (this._isRunning) {
      this._pendingStore = storeName;
      return;
    }

    this._isRunning = true;
    this._onStatusChange?.(storeName, "ingesting");

    try {
      const { store, indexer, config } = entry;

      // 1. Discover project files
      const files = discoverFiles(this._cwd, config.include, config.exclude);
      const keyFiles = new Map(
        files.slice(0, 100).map((f) => [f.relativePath, f.content]),
      );
      const fileTree = getProjectTree(this._cwd, config.exclude);

      // 2. Read existing memory
      const existingMemory = new Map<string, string>();
      for (const relPath of store.listRelativeFiles()) {
        const content = store.readFile(relPath);
        if (content !== null) {
          existingMemory.set(relPath, content);
        }
      }

      // 3. Call ingestion LLM
      const llm = this._getLlmContext();
      const systemPrompt = buildIngestionSystemPrompt();
      const userPrompt = buildIngestionUserPrompt({
        storeName,
        projectRoot: this._cwd,
        fileTree,
        keyFiles,
        existingMemory,
        recentChanges: "",
        includePatterns: config.include,
        excludePatterns: config.exclude,
      });

      const response = await llm.complete({
        model: { id: config.ingestionModel ?? "active", provider: config.ingestionModel?.split("/")[0] ?? "active" },
        apiKey: "",
        systemPrompt,
        userPrompt,
      });

      // 4. Parse response
      const parsed = this._parseResponse(response.content);
      if (!parsed) {
        console.warn(
          `[pi-project-memory] Ingestion LLM returned unparseable response for "${storeName}"`,
        );
        return;
      }

      // 5. Write updated files
      const changedFiles: string[] = [];
      for (const [filePath, content] of Object.entries(parsed.files)) {
        store.writeFile(filePath, content);
        changedFiles.push(filePath);
      }

      // 6. Re-index changed files
      if (changedFiles.length > 0) {
        await indexer.indexFiles(changedFiles);
      }

      // 7. Update metadata
      store.setLastIngestedAt(new Date().toISOString());

      this._onStatusChange?.(storeName, "ingested");
    } finally {
      this._isRunning = false;

      // If another ingestion was queued while we were running, start it
      if (this._pendingStore) {
        const next = this._pendingStore;
        this._pendingStore = null;
        this.runIngestion(next).catch(() => {});
      }
    }
  }

  /**
   * Cancel pending ingestion.
   */
  cancel(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingStore = null;
  }

  /**
   * Parse the LLM's response, extracting JSON from markdown code blocks if needed.
   */
  private _parseResponse(content: string): IngestionResponse | null {
    // Try direct JSON parse first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && "files" in parsed) {
        return parsed as IngestionResponse;
      }
    } catch {
      // Not direct JSON, continue
    }

    // Try extracting from ```json block
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (parsed && typeof parsed === "object" && "files" in parsed) {
          return parsed as IngestionResponse;
        }
      } catch {
        // Not valid JSON in block
      }
    }

    // Try finding any JSON object in the response
    const objectMatch = content.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (parsed && typeof parsed === "object" && "files" in parsed) {
          return parsed as IngestionResponse;
        }
      } catch {
        // Still not parseable
      }
    }

    return null;
  }
}