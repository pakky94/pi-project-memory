/**
 * Embedding service — converts text to vectors via a configurable HTTP endpoint.
 *
 * Supported providers:
 * - "openai-compatible": POST /v1/embeddings, body {model, input}, returns {data[{embedding}]}
 * - "ollama": POST /api/embed, body {model, input}, returns {embeddings[]}
 */

import type { EmbeddingConfig } from "./config.ts";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * Get the API key from config or environment variable.
 */
function getApiKey(config: EmbeddingConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  // Env var fallback
  return process.env["EMBEDDING_API_KEY"] || undefined;
}

/**
 * Create an embedding provider based on config.
 */
export function createEmbeddingProvider(config: EmbeddingConfig | null): EmbeddingProvider | null {
  if (!config) return null;

  const provider = config.provider ?? "openai-compatible";
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  const model = config.model ?? "nomic-embed-text";

  if (!baseUrl) {
    console.warn("[pi-project-memory] Embedding config missing baseUrl. Semantic search disabled.");
    return null;
  }

  if (provider === "ollama") {
    return createOllamaProvider(baseUrl, model, config.dimensions ?? 768);
  }

  return createOpenAICompatibleProvider(baseUrl, model, getApiKey(config), config.dimensions ?? 768);
}

/**
 * OpenAI-compatible embedding provider (works with OpenAI, vLLM, LiteLLM, etc.)
 */
function createOpenAICompatibleProvider(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  dimensions: number,
): EmbeddingProvider {
  const url = `${baseUrl}/embeddings`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(
        `Embedding API error (${response.status}): ${errText}`,
      );
    }

    const json = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to preserve order
    json.data.sort((a, b) => a.index - b.index);
    return json.data.map((d) => d.embedding);
  }

  return {
    embed,
    dimensions,
  };
}

/**
 * Ollama embedding provider.
 */
function createOllamaProvider(
  baseUrl: string,
  model: string,
  dimensions: number,
): EmbeddingProvider {
  const url = `${baseUrl}/api/embed`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(
        `Ollama embedding error (${response.status}): ${errText}`,
      );
    }

    const json = (await response.json()) as {
      embeddings: number[][];
    };

    return json.embeddings;
  }

  return {
    embed,
    dimensions,
  };
}

/**
 * Debounced batch embedder — batches texts and calls the provider in batches.
 */
export class BatchEmbedder {
  private provider: EmbeddingProvider;
  private batchSize: number;
  private retries: number;

  constructor(provider: EmbeddingProvider, batchSize = 20, retries = 1) {
    this.provider = provider;
    this.batchSize = batchSize;
    this.retries = retries;
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  /**
   * Embed a list of texts, automatically batching.
   * Retries once on failure with exponential backoff.
   */
  async embedAll(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      results.push(...(await this.embedWithRetry(batch)));
    }

    return results;
  }

  private async embedWithRetry(texts: string[], attempt = 0): Promise<number[][]> {
    try {
      return await this.provider.embed(texts);
    } catch (err) {
      if (attempt < this.retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(
          `[pi-project-memory] Embedding failed (attempt ${attempt + 1}), retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, delay));
        return this.embedWithRetry(texts, attempt + 1);
      }
      console.warn(
        `[pi-project-memory] Embedding failed after ${attempt + 1} attempts, returning zero vectors:`,
        err instanceof Error ? err.message : err,
      );
      // Return zero vectors as fallback
      return texts.map(() => new Array(this.provider.dimensions).fill(0));
    }
  }
}