/**
 * Chunker — splits markdown text into semantically meaningful chunks.
 *
 * Strategy:
 * 1. Split on ## and ### headings (section-level chunks)
 * 2. If a section exceeds ~512 tokens (estimated as chars/4), split on blank lines
 * 3. Each chunk tracks its file path, heading context, and line range
 */

/**
 * A single chunk of a markdown file.
 */
export interface Chunk {
  /** File path relative to store base */
  filePath: string;
  /** The heading hierarchy leading to this chunk (e.g. "Architecture > API Layer") */
  heading: string;
  /** 1-based start line in the original file */
  startLine: number;
  /** 1-based end line in the original file */
  endLine: number;
  /** The chunk text content */
  content: string;
}

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is a heuristic; exact tokenization isn't needed for chunking.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_TOKENS_PER_CHUNK = 512;

/**
 * Split markdown content into chunks.
 */
export function chunkMarkdown(
  markdown: string,
  filePath: string,
  maxTokens: number = MAX_TOKENS_PER_CHUNK,
): Chunk[] {
  const lines = markdown.split("\n");
  const chunks: Chunk[] = [];

  // Track heading hierarchy
  let headingStack: { level: number; text: string }[] = [];
  let sectionStartLine = 1;
  let sectionLines: string[] = [];

  function currentHeading(): string {
    return headingStack.map((h) => h.text).join(" > ");
  }

  function flushSection(endLine: number): void {
    const text = sectionLines.map((l) => l.trimEnd()).join("\n").trim();
    if (text.length === 0) return;

    const heading = currentHeading();

    if (estimateTokens(text) <= maxTokens) {
      chunks.push({
        filePath,
        heading,
        startLine: sectionStartLine,
        endLine,
        content: text,
      });
    } else {
      // Section is too large — split further on paragraph boundaries
      splitParagraphs(sectionLines, filePath, heading, sectionStartLine, endLine, maxTokens, chunks);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const headingMatch = line.match(/^(#{2,3})\s+(.+)/);

    if (headingMatch) {
      // Flush the previous section before starting a new one
      if (sectionLines.length > 0) {
        flushSection(lineNum - 1);
      }

      const level = headingMatch[1].length; // 2 or 3
      const text = headingMatch[2].trim();

      // Pop headings that are at same or deeper level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      headingStack.push({ level, text });
      sectionStartLine = lineNum;
      sectionLines = [line];
    } else {
      sectionLines.push(line);
    }
  }

  // Flush the last section
  if (sectionLines.length > 0) {
    flushSection(lines.length);
  }

  return chunks;
}

/**
 * Split a large section into paragraph-sized chunks.
 */
function splitParagraphs(
  lines: string[],
  filePath: string,
  heading: string,
  startLine: number,
  endLine: number,
  maxTokens: number,
  chunks: Chunk[],
): void {
  // Group lines into paragraphs (separated by blank lines)
  const paragraphs: { lines: string[]; startLine: number; endLine: number }[] = [];
  let currentPara: string[] = [];
  let paraStartLine = startLine;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = startLine + i;

    if (line.trim() === "" && currentPara.length > 0) {
      paragraphs.push({
        lines: currentPara,
        startLine: paraStartLine,
        endLine: lineNum - 1,
      });
      currentPara = [];
      paraStartLine = lineNum + 1;
    } else {
      currentPara.push(line);
    }
  }

  if (currentPara.length > 0) {
    paragraphs.push({
      lines: currentPara,
      startLine: paraStartLine,
      endLine: endLine,
    });
  }

  // Merge paragraphs into chunks respecting maxTokens
  let currentChunk: string[] = [];
  let chunkStartLine = paragraphs[0]?.startLine ?? startLine;

  for (const para of paragraphs) {
    const paraText = para.lines.map((l) => l.trimEnd()).join("\n");
    const wouldBeTokens = estimateTokens(
      [...currentChunk, paraText].join("\n\n"),
    );

    if (currentChunk.length > 0 && wouldBeTokens > maxTokens) {
      // Flush current chunk
      chunks.push({
        filePath,
        heading,
        startLine: chunkStartLine,
        endLine: para.startLine - 1,
        content: currentChunk.join("\n\n"),
      });
      currentChunk = [];
      chunkStartLine = para.startLine;
    }

    currentChunk.push(paraText);
  }

  // Flush last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      filePath,
      heading,
      startLine: chunkStartLine,
      endLine,
      content: currentChunk.join("\n\n"),
    });
  }
}

/**
 * Chunk all markdown content in a map of filePath -> content.
 */
export function chunkAllMarkdown(
  files: Map<string, string>,
  maxTokens?: number,
): Chunk[] {
  const allChunks: Chunk[] = [];
  for (const [filePath, content] of files) {
    const fileChunks = chunkMarkdown(content, filePath, maxTokens);
    allChunks.push(...fileChunks);
  }
  return allChunks;
}