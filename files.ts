/**
 * File discovery — recursively find files matching include/exclude patterns.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";

export interface FileEntry {
  /** Absolute path */
  fullPath: string;
  /** Path relative to root */
  relativePath: string;
  /** File content */
  content: string;
}

/**
 * Walk a directory recursively, collecting files that match include/exclude patterns.
 */
export function discoverFiles(
  rootDir: string,
  includePatterns: string[],
  excludePatterns: string[],
  maxFiles: number = 500,
): FileEntry[] {
  const results: FileEntry[] = [];

  function walk(dir: string) {
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;

      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      // Check exclusion first
      if (excludePatterns.some((p) => minimatch(relPath, p, { dot: true }))) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Check inclusion
        if (!includePatterns.some((p) => minimatch(relPath, p, { dot: true }))) {
          continue;
        }

        try {
          const content = readFileSync(fullPath, "utf-8");
          results.push({ fullPath, relativePath: relPath, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  if (existsSync(rootDir)) {
    walk(rootDir);
  }

  return results;
}

/**
 * Get a text representation of the project tree.
 */
export function getProjectTree(
  rootDir: string,
  excludePatterns: string[],
  maxDepth: number = 3,
): string {
  const lines: string[] = [rootDir];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      if (excludePatterns.some((p) => minimatch(relPath, p, { dot: true }))) {
        continue;
      }

      const prefix = "  ".repeat(depth) + (entry.isDirectory() ? "📁 " : "📄 ");
      lines.push(prefix + entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(rootDir, 1);
  return lines.join("\n");
}