/**
 * MemoryIndexer — chunks markdown files, embeds them, and stores vectors in sqlite-vec.
 *
 * Handles:
 * - Full re-index (drop and rebuild)
 * - Incremental update for specific files
 * - Semantic search via KNN query
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore, SearchResult } from "./store.ts";
import { chunkMarkdown } from "./chunker.ts";
import type { BatchEmbedder } from "./embedding.ts";
import type { StoreConfigResolved } from "./config.ts";

/**
 * Simple string hash for cache invalidation.
 */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

export class MemoryIndexer {
  private store: MemoryStore;
  private embedder: BatchEmbedder | null;

  /**
   * @param embedder - if null, semantic search is disabled;
   *   `search()` falls back to basic text (LIKE) matching.
   */
  constructor(
    store: MemoryStore,
    embedder: BatchEmbedder | null,
  ) {
    this.store = store;
    this.embedder = embedder;
  }

  get hasSemanticSearch(): boolean {
    return this.embedder !== null;
  }

  /**
   * Full re-index: chunk all markdown files, embed, store in vec0.
   */
  async reindex(): Promise<void> {
    const db = this.store.getDb();
    if (!db) return;

    const files = this.store.listFiles();
    const fileContents: Map<string, string> = new Map();

    for (const fullPath of files) {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        fileContents.set(fullPath, content);
      }
    }

    await this._indexContent(fileContents, true);
  }

  /**
   * Index specific files (incremental). Removes old chunks for these files first.
   */
  async indexFiles(relativePaths: string[]): Promise<void> {
    const db = this.store.getDb();
    if (!db) return;

    const fileContents: Map<string, string> = new Map();

    for (const relPath of relativePaths) {
      const content = this.store.readFile(relPath);
      if (content !== null) {
        fileContents.set(relPath, content);
      }
    }

    if (fileContents.size === 0) return;

    await this._indexContent(fileContents, false, relativePaths);
  }

  /**
   * Common indexing logic.
   */
  private async _indexContent(
    files: Map<string, string>,
    isFullReindex: boolean,
    removeOldFor?: string[],
  ): Promise<void> {
    const db = this.store.getDb();
    if (!db) return;

    // If full reindex, drop and recreate vec0 (only if embedding is available)
    if (isFullReindex) {
      if (this.embedder) {
        try {
          db.exec("DROP TABLE IF EXISTS vec0_index");
        } catch {
          // May not exist
        }

        const dimensions = this.embedder.dimensions;
        db.exec(
          `CREATE VIRTUAL TABLE vec0_index USING vec0(embedding FLOAT32(${dimensions}), chunk_id INTEGER)`,
        );
      } else {
        // No embedding — ensure any stale vec0 table is cleaned up
        try {
          db.exec("DROP TABLE IF EXISTS vec0_index");
        } catch {
          // May not exist
        }
      }
    }

    // Chunk all files
    const allChunks: {
      filePath: string;
      content: string;
      heading: string;
      startLine: number;
      endLine: number;
    }[] = [];

    for (const [filePath, content] of files) {
      const chunks = chunkMarkdown(content, filePath);
      for (const chunk of chunks) {
        allChunks.push(chunk);
      }
    }

    if (allChunks.length === 0) return;

    // Remove old chunks for the affected files (incremental update)
    if (removeOldFor && removeOldFor.length > 0) {
      const placeholders = removeOldFor.map(() => "?").join(",");

      if (this.embedder) {
        // Also remove from vec0 via chunk_id
        for (const relPath of removeOldFor) {
          const oldIds = db
            .prepare("SELECT id FROM chunks WHERE file_path = ?")
            .all(relPath) as { id: number }[];
          for (const { id } of oldIds) {
            try {
              db.prepare("DELETE FROM vec0_index WHERE chunk_id = ?").run(
                BigInt(id),
              );
            } catch {
              // Row may not exist
            }
          }
        }
      }

      const removeStmt = db.prepare(
        `DELETE FROM chunks WHERE file_path IN (${placeholders})`,
      );
      removeStmt.run(...removeOldFor);
    }

    // Prepare insert statement for chunks
    const chunkIns = db.prepare(
      "INSERT INTO chunks (file_path, heading, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)",
    );

    let embeddings: number[][] | null = null;
    let vecIns: ReturnType<typeof db.prepare> | null = null;

    if (this.embedder) {
      vecIns = db.prepare(
        "INSERT INTO vec0_index(chunk_id, embedding) VALUES(CAST(? AS INTEGER), ?)",
      );
      // Embed in batches
      const texts = allChunks.map((c) => c.content);
      embeddings = await this.embedder.embedAll(texts);
    }

    // Insert chunks (and optionally vectors) in a transaction
    db.exec("BEGIN");
    try {
      for (let i = 0; i < allChunks.length; i++) {
        const chunk = allChunks[i];

        chunkIns.run(
          chunk.filePath,
          chunk.heading,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
        );

        if (vecIns && embeddings) {
          const lastId = (
            db.prepare("SELECT last_insert_rowid() as id").get() as {
              id: number;
            }
          ).id;

          const buf = Buffer.from(new Float32Array(embeddings[i]).buffer);
          vecIns.run(BigInt(lastId), buf);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Search across memory chunks.
   *
   * If an embedder is configured, runs semantic (vector) search.
   * Otherwise falls back to basic text matching with LIKE.
   */
  async search(
    query: string,
    limit: number = 5,
  ): Promise<SearchResult[]> {
    const db = this.store.getDb();
    if (!db) return [];

    if (this.embedder) {
      return this._semanticSearch(db, query, limit);
    }

    return this._textSearch(db, query, limit);
  }

  /**
   * Semantic (vector) KNN search.
   */
  private async _semanticSearch(
    db: ReturnType<typeof this.store.getDb>,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const [queryVec] = await this.embedder!.embedAll([query]);
    if (!queryVec || queryVec.length === 0) return [];

    const queryBuf = Buffer.from(new Float32Array(queryVec).buffer);

    const results = db
      .prepare(
        `SELECT
          c.file_path,
          c.heading,
          c.start_line,
          c.end_line,
          c.content,
          v.distance
        FROM vec0_index v
        JOIN chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ?
        AND k = ?`,
      )
      .all(queryBuf, limit) as {
      file_path: string;
      heading: string | null;
      start_line: number;
      end_line: number;
      content: string;
      distance: number;
    }[];

    return results.map((r) => ({
      store: this.store.name,
      filePath: r.file_path,
      heading: r.heading,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      distance: r.distance,
    }));
  }

  /**
   * Text-based fallback search using LIKE.
   * Splits the query into words and matches any word in content or heading.
   */
  private _textSearch(
    db: ReturnType<typeof this.store.getDb>,
    query: string,
    limit: number,
  ): SearchResult[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) {
      // Return most recent chunks
      const rows = db
        .prepare(
          `SELECT file_path, heading, start_line, end_line, content
           FROM chunks ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as any[];
      return rows.map((r) => ({
        store: this.store.name,
        filePath: r.file_path,
        heading: r.heading,
        startLine: r.start_line,
        endLine: r.end_line,
        content: r.content,
        distance: 0,
      }));
    }

    // Build WHERE clause matching any word in content or heading
    const conditions = words.map(
      () => "(c.content LIKE ? OR c.heading LIKE ?)",
    );
    const params: string[] = [];
    for (const word of words) {
      params.push(`%${word}%`, `%${word}%`);
    }

    const sql = `
      SELECT c.file_path, c.heading, c.start_line, c.end_line, c.content
      FROM chunks c
      WHERE ${conditions.join(" OR ")}
      ORDER BY c.id DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(...params, limit) as any[];
    return rows.map((r) => ({
      store: this.store.name,
      filePath: r.file_path,
      heading: r.heading,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      distance: 0,
    }));
  }

  /**
   * Check if the index needs rebuilding (no vec0 table or no chunks).
   */
  async needsRebuild(): Promise<boolean> {
    const db = this.store.getDb();
    if (!db) return true;

    try {
      const count = db.prepare(
        "SELECT COUNT(*) as cnt FROM chunks",
      ).get() as { cnt: number };
      return count.cnt === 0;
    } catch {
      return true;
    }
  }

  /**
   * Get the number of indexed chunks.
   */
  async chunkCount(): Promise<number> {
    const db = this.store.getDb();
    if (!db) return 0;
    try {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
      return count.cnt;
    } catch {
      return 0;
    }
  }
}