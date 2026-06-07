/**
 * Prompts for the ingestion LLM.
 *
 * The ingestion LLM receives:
 * - Project file tree and key source files
 * - A listing of existing memory files (names + headings only — not full content)
 * - Recent conversation context (what was discussed)
 * - Recent file changes
 *
 * It produces updated markdown files as structured JSON.
 */

export interface IngestionParams {
  storeName: string;
  projectRoot: string;
  fileTree: string;
  keyFiles: Map<string, string>;
  /** Memory file listing: path -> first heading / summary */
  memoryListing: Map<string, string>;
  /** Recent conversation messages (last N user/assistant exchanges) */
  conversationContext: string;
  /** Summary of files that were changed */
  recentChanges: string;
  includePatterns: string[];
  excludePatterns: string[];
}

/**
 * Build the system prompt for the ingestion LLM.
 */
export function buildIngestionSystemPrompt(): string {
  return `You are a project documentation writer named "memory-bot". Your job is to maintain concise, accurate markdown memory files about a software project.

## Your Mission

Update the memory files to reflect the current state of the project. The memory files help a coding assistant understand the project architecture, key modules, data flow, and decisions.

## How to Work

1. You will receive a listing of existing memory files (names + section headings). This tells you what's already documented.
2. You will receive recent conversation context — this tells you what was discussed and decided.
3. You will receive the project file tree and key source files.
4. Based on all this, decide which memory files need updating and produce the new content.

## Guidelines

1. Write clear, concise markdown
2. Focus on structure, purpose, and relationships — not implementation details
3. Include file paths and line ranges as references where helpful
4. Keep section headings using ## and ### for proper chunking
5. If nothing has changed, respond with an empty files object
6. Never delete memory files unless the corresponding code no longer exists
7. Preserve information that is still accurate even if a file wasn't explicitly reviewed
8. Use the conversation context to understand WHY changes were made — capture decisions and reasoning

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

  // Key source files (limited to most important ones)
  if (params.keyFiles.size > 0) {
    const keyFileEntries: string[] = [];
    for (const [path, content] of params.keyFiles) {
      keyFileEntries.push(`### ${path}\n\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
    }
    sections.push(`## Key Source Files\n\n${keyFileEntries.join("\n\n")}`);
  }

  // Memory file listing (names + headings only, not full content)
  if (params.memoryListing.size > 0) {
    const listing: string[] = [];
    for (const [path, summary] of params.memoryListing) {
      listing.push(`- \`${path}\`: ${summary.slice(0, 200)}`);
    }
    sections.push(`## Existing Memory Files\n\n${listing.join("\n")}\n\n(Only file names and headings shown. Use the headings to decide which files need updating.)`);
  }

  // Conversation context
  if (params.conversationContext) {
    sections.push(`## Recent Conversation\n\n${params.conversationContext}`);
  }

  // Recent changes
  if (params.recentChanges) {
    sections.push(`## Recent File Changes\n\n${params.recentChanges}`);
  }

  sections.push(`## Task\n\nReview the project state, conversation context, and existing memory above. Update the memory files to reflect the current state. Only include files that need changes. If nothing changed, return an empty files object.`);

  return sections.join("\n\n");
}