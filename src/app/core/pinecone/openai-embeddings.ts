import { PineconeUploadError } from './types';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIMENSIONS = 1_536;
export const OPENAI_EMBEDDING_BATCH_SIZE = 96;

const MAX_REQUEST_ATTEMPTS = 4;

export interface OpenAIEmbeddingClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly fetchImplementation?: typeof fetch;
}

/** Server-side embeddings client. Never instantiate this class in browser application code. */
export class OpenAIEmbeddingClient {
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(config: OpenAIEmbeddingClientConfig) {
    if (!config.apiKey.trim()) {
      throw configurationError('OPENAI_API_KEY must not be empty');
    }
    const model = config.model?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
    const dimensions = config.dimensions ?? OPENAI_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw configurationError('OpenAI embedding dimensions must be a positive integer');
    }

    this.apiKey = config.apiKey.trim();
    this.baseUrl = normalizeOpenAIBaseUrl(config.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
    this.model = model;
    this.dimensions = dimensions;
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async createEmbeddings(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0 || texts.length > OPENAI_EMBEDDING_BATCH_SIZE) {
      throw new PineconeUploadError(
        'INVALID_LOCAL_DATA',
        `OpenAI embedding batch must contain 1-${OPENAI_EMBEDDING_BATCH_SIZE} texts`,
      );
    }
    if (texts.some((text) => !text.trim())) {
      throw new PineconeUploadError(
        'INVALID_LOCAL_DATA',
        'OpenAI embedding inputs must not be empty',
      );
    }

    const payload = await this.requestJson(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: 'float',
        dimensions: this.dimensions,
      }),
    });
    const response = asRecord(payload);
    const responseModel = response['model'];
    if (responseModel !== this.model) {
      throw embeddingResponseError(
        `response model is ${typeof responseModel === 'string' ? responseModel : 'invalid'}; ` +
          `expected ${this.model}`,
      );
    }
    const data = response['data'];
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw embeddingResponseError(
        `response contains ${Array.isArray(data) ? data.length : 'invalid'} embeddings; ` +
          `expected ${texts.length}`,
      );
    }

    const byIndex = new Map<number, readonly number[]>();
    for (const itemValue of data) {
      const item = asRecord(itemValue);
      const index = item['index'];
      const embedding = item['embedding'];
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= texts.length
      ) {
        throw embeddingResponseError('response contains an embedding with an invalid index');
      }
      if (!Array.isArray(embedding)) {
        throw embeddingResponseError(`embedding index ${index} is not an array`);
      }
      if (embedding.length !== this.dimensions) {
        throw embeddingResponseError(
          `embedding index ${index} has ${embedding.length} dimensions; expected ${this.dimensions}`,
        );
      }
      if (embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw embeddingResponseError(`embedding index ${index} contains a non-finite value`);
      }
      if (byIndex.has(index)) {
        throw embeddingResponseError(`response contains duplicate embedding index ${index}`);
      }
      byIndex.set(index, embedding as number[]);
    }

    return texts.map((_text, index) => {
      const embedding = byIndex.get(index);
      if (!embedding) {
        throw embeddingResponseError(`response is missing embedding index ${index}`);
      }
      return embedding;
    });
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          ...init,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...init.headers,
          },
        });
      } catch (error) {
        if (attempt === MAX_REQUEST_ATTEMPTS) {
          throw new PineconeUploadError(
            'EMBEDDING_REQUEST_FAILED',
            `OpenAI network request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await retryDelay(attempt);
        continue;
      }

      const responseText = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          throw embeddingResponseError(`HTTP ${response.status} returned invalid JSON`);
        }
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_REQUEST_ATTEMPTS) {
        await retryDelay(attempt, response.headers.get('retry-after'));
        continue;
      }

      const safeDetail = responseText.replace(/\s+/gu, ' ').trim().slice(0, 300);
      throw new PineconeUploadError(
        'EMBEDDING_REQUEST_FAILED',
        `OpenAI HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`,
        response.status,
      );
    }

    throw new PineconeUploadError('EMBEDDING_REQUEST_FAILED', 'OpenAI request attempts exhausted');
  }
}

export function normalizeOpenAIBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw configurationError('OPENAI_BASE_URL is not a valid URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw configurationError('OPENAI_BASE_URL must be an HTTPS URL without credentials or query');
  }
  return url.toString().replace(/\/+$/u, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw embeddingResponseError('response has an invalid shape');
  }
  return value as Record<string, unknown>;
}

function retryDelay(attempt: number, retryAfter: string | null = null): Promise<void> {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const milliseconds = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 0) * 1_000, 30_000)
    : 500 * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function configurationError(reason: string): PineconeUploadError {
  return new PineconeUploadError('INVALID_CONFIGURATION', reason);
}

function embeddingResponseError(reason: string): PineconeUploadError {
  return new PineconeUploadError('EMBEDDING_REQUEST_FAILED', `OpenAI ${reason}`);
}
