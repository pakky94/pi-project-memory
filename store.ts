/**
 * MemoryStore — manages a single store's directory, markdown files, and sqlite-vec database.
 *
 * Each store has:
 * - A directory for markdown files (e.g. .pi/memory/project/)
 * - A sqlite-vec database at <path>/vec.db
 * - A meta table for cache invalidation and timestamps
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { StoreConfigResolved } from "./config.ts";

export interface SearchResult {
  store: string;
  filePath: string;
  heading: string | null;
  startLine: number;
  endLine: number;
  content: string;
  distance: number;
}

export class MemoryStore {
  public readonly name: string;
  public readonly basePath: string;
  public readonly dbPath: string;
  public readonly config: StoreConfigResolved;
  private _db: DatabaseSync | null = null;
  private _dbAvailable: boolean = false;

  constructor(config: StoreConfigResolved) {
    this.name = config.name;
    this.basePath = config.path;
    this.dbPath = join(config.path, "vec.db");
    this.config = config;
  }

  /**
   * Initialize the store: create directory, open DB, create tables.
   */
  async init(): Promise<void> {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }

    try {
      this._db = new DatabaseSync(this.dbPath, { allowExtension: true });
      sqliteVec.load(this._db);

      const dimensions = this.config.embedding?.dimensions ?? 768;
      this._db.exec(`
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
          embedding FLOAT32(${dimensions})
        );

        CREATE TABLE IF NOT EXISTS store_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      this._dbAvailable = true;
    } catch (err) {
      console.warn(
        `[pi-project-memory] Failed to initialize sqlite-vec for store "${this.name}":`,
        err instanceof Error ? err.message : err,
      );
      this._db = null;
      this._dbAvailable = false;
    }
  }

  /**
   * Whether the vector database is available.
   */
  get isDbAvailable(): boolean {
    return this._dbAvailable;
  }

  /**
   * Get the database instance (may be null if DB init failed).
   */
  getDb(): DatabaseSync | null {
    return this._db;
  }

  /**
   * List markdown files in this store.
   */
  listFiles(): string[] {
    const files: string[] = [];
    const walkDir = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      }
    };
    walkDir(this.basePath);
    return files;
  }

  /**
   * List markdown files with paths relative to the store's base path.
   */
  listRelativeFiles(): string[] {
    return this.listFiles().map((f) => relative(this.basePath, f));
  }

  /**
   * Read a memory file by path relative to store base.
   * Returns null if file doesn't exist.
   */
  readFile(relativePath: string): string | null {
    const fullPath = resolve(this.basePath, relativePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return null;
    }
    try {
      return readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write a memory file. Creates directories as needed.
   */
  writeFile(relativePath: string, content: string): void {
    const fullPath = resolve(this.basePath, relativePath);
    const dir = resolve(fullPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }

  /**
   * Get metadata value from the store.
   */
  getMeta(key: string): string | null {
    if (!this._db) return null;
    const row = this._db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Set metadata value in the store.
   */
  setMeta(key: string, value: string): void {
    if (!this._db) return;
    this._db
      .prepare(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Get last ingestion timestamp (ISO string), or null if never ingested.
   */
  getLastIngestedAt(): string | null {
    return this.getMeta("last_ingested_at");
  }

  /**
   * Set last ingestion timestamp.
   */
  setLastIngestedAt(iso: string): void {
    this.setMeta("last_ingested_at", iso);
  }

  /**
   * Get file hash for cache invalidation.
   */
  getFileHash(relativePath: string): string | null {
    return this.getMeta(`hash:${relativePath}`);
  }

  /**
   * Set file hash.
   */
  setFileHash(relativePath: string, hash: string): void {
    this.setMeta(`hash:${relativePath}`, hash);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        // Ignore close errors
      }
      this._db = null;
      this._dbAvailable = false;
    }
  }
}