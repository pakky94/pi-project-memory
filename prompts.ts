/**
 * Prompts for the ingestion LLM.
 *
 * The ingestion LLM reads project state and existing memory,
 * then produces updated markdown files.
 */

export interface IngestionParams {
  /** Name of the store being ingested */
  storeName: string;
  /** Project root directory path */
  projectRoot: string;
  /** Text representation of the project file tree */
  fileTree: string;
  /** Key files discovered (path -> content) */
  keyFiles: Map<string, string>;
  /** Existing memory files (path -> content) */
  existingMemory: Map<string, string>;
  /** Recent changes summary (e.g. files that were edited) */
  recentChanges: string;
  /** File include patterns */
  includePatterns: string[];
  /** File exclude patterns */
  excludePatterns: string[];
}

/**
 * Build the system prompt for the ingestion LLM.
 */
export function buildIngestionSystemPrompt(): string {
  return `You are a project documentation writer named "memory-bot". Your job is to maintain concise, accurate markdown memory files about a software project.

## Your Mission

Update the memory files to reflect the current state of the project. The memory files help a coding assistant understand the project architecture, key modules, data flow, and decisions.

## Guidelines

1. Write clear, concise markdown
2. Focus on structure, purpose, and relationships — not implementation details
3. Include file paths and line ranges as references where helpful
4. Keep section headings using ## and ### for proper chunking
5. If nothing has changed, respond with an empty files object
6. Never delete memory files unless the corresponding code no longer exists
7. Preserve information that is still accurate even if a file wasn't explicitly reviewed

## Output Format

Respond with ONLY a JSON object in this exact format:

\`\`\`json
{
  "files": {
    "architecture.md": "# Architecture\\n\\n## Overview\\nThis project is...",
    "modules/api.md": "# API Module\\n\\n## Purpose\\nHandles HTTP requests..."
  }
}
\`\`\`

Only include files that need to be created or updated. Omit files that haven't changed.
The JSON must be valid — escape newlines and quotes properly.`;
}

/**
 * Build the user prompt for the ingestion LLM.
 */
export function buildIngestionUserPrompt(params: IngestionParams): string {
  const sections: string[] = [];

  sections.push(`## Store: ${params.storeName}`);
  sections.push(`## Project Root\n\n${params.projectRoot}`);
  sections.push(`## Project File Tree\n\n\`\`\`\n${params.fileTree}\n\`\`\``);

  // Key files
  if (params.keyFiles.size > 0) {
    const keyFileEntries: string[] = [];
    for (const [path, content] of params.keyFiles) {
      keyFileEntries.push(`### ${path}\n\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
    }
    sections.push(`## Key Source Files\n\n${keyFileEntries.join("\n\n")}`);
  }

  // Existing memory
  if (params.existingMemory.size > 0) {
    const memoryEntries: string[] = [];
    for (const [path, content] of params.existingMemory) {
      memoryEntries.push(`### ${path}\n\n${content}`);
    }
    sections.push(`## Existing Memory Files\n\n${memoryEntries.join("\n\n")}`);
  }

  // Recent changes
  if (params.recentChanges) {
    sections.push(`## Recent Changes\n\n${params.recentChanges}`);
  }

  sections.push(`## Task\n\nReview the project state above and update the memory files. Only include files that need changes. If nothing changed, return an empty files object.`);

  return sections.join("\n\n");
}