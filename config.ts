/**
 * Config loading for pi-project-memory extension.
 *
 * Resolution order:
 * 1. <cwd>/memory.config.json (repo root)
 * 2. <cwd>/.pi/memory.json (pi config folder fallback)
 * 3. Empty config (no stores, extension runs silently)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

export interface StoreConfigResolved {
  name: string;
  path: string;
  ingestionModel: string | null; // null = use active model
  embedding: EmbeddingConfig | null; // null = no semantic search
  include: string[];
  exclude: string[];
  autoinject: boolean;
  debounceMs: number;
}

/**
 * Default include/exclude patterns for file discovery during ingestion.
 */
const DEFAULT_INCLUDE = ["**/*.{ts,tsx,js,jsx,json,md,yaml,yml,toml}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/.pi/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/__pycache__/**",
];

/**
 * Load the config file from the project root.
 * Returns null if no config found.
 */
export function loadConfig(cwd: string): MemoryConfig | null {
  const primaryPath = resolve(cwd, "memory.config.json");
  const fallbackPath = resolve(cwd, ".pi", "memory.json");

  for (const configPath of [primaryPath, fallbackPath]) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as MemoryConfig;
        return parsed;
      } catch (err) {
        console.warn(
          `[pi-project-memory] Failed to parse config at ${configPath}:`,
          err instanceof SyntaxError ? err.message : err,
        );
        return null;
      }
    }
  }

  return null;
}

/**
 * Resolve a store's path relative to the config file's directory.
 */
export function resolveStorePath(configDir: string, store: StoreConfig): string {
  if (store.path) {
    return resolve(configDir, store.path);
  }
  return resolve(configDir, ".pi", "memory", store.name);
}

export function configFilePath(cwd: string): string | null {
  const primaryPath = resolve(cwd, "memory.config.json");
  const fallbackPath = resolve(cwd, ".pi", "memory.json");
  if (existsSync(primaryPath)) return primaryPath;
  if (existsSync(fallbackPath)) return fallbackPath;
  return null;
}

/**
 * Resolve a store's config by merging global defaults with per-store overrides.
 */
export function resolveStoreConfig(
  store: StoreConfig,
  defaults: MemoryConfig["defaults"],
  configDir: string,
): StoreConfigResolved {
  const path = resolveStorePath(configDir, store);

  return {
    name: store.name,
    path,
    ingestionModel: store.ingestionModel ?? defaults?.ingestionModel ?? null,
    embedding: store.embedding ?? defaults?.embedding ?? null,
    include: store.include ?? defaults?.include ?? DEFAULT_INCLUDE,
    exclude: store.exclude ?? defaults?.exclude ?? DEFAULT_EXCLUDE,
    autoinject: defaults?.autoinject ?? true,
    debounceMs: defaults?.debounceMs ?? 30_000,
  };
}

/**
 * Load and resolve all stores from config.
 */
export function loadStores(cwd: string): StoreConfigResolved[] {
  const config = loadConfig(cwd);
  if (!config || !config.stores || config.stores.length === 0) {
    return [];
  }

  return config.stores.map((s) => resolveStoreConfig(s, config.defaults, cwd));
}