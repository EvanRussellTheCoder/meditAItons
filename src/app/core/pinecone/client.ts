import {
  PineconeClientConfig,
  PineconeFetchedRecord,
  PineconeIndexDescription,
  PineconeNamespaceDescription,
  PineconeQueryMatch,
  PineconeTextRecord,
  PineconeUploadError,
  PineconeVectorRecord,
} from './types';

export const PINECONE_API_VERSION = '2026-04';
export const PINECONE_MAX_UPSERT_BYTES = 2 * 1_024 * 1_024;
const MAX_REQUEST_ATTEMPTS = 4;

/** Server-side REST client. Never instantiate this class in browser application code. */
export class PineconeRestClient {
  private readonly apiKey: string;
  private readonly indexHost: string;
  private readonly indexName: string | undefined;
  private readonly apiVersion: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(config: PineconeClientConfig) {
    if (!config.apiKey.trim()) {
      throw configurationError('PINECONE_API_KEY must not be empty');
    }
    this.apiKey = config.apiKey.trim();
    this.indexHost = normalizeIndexHost(config.indexHost);
    this.indexName = config.indexName?.trim() || undefined;
    this.apiVersion = config.apiVersion ?? PINECONE_API_VERSION;
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async validateIndexConfiguration(): Promise<PineconeIndexDescription | undefined> {
    if (!this.indexName) {
      return undefined;
    }

    const payload = await this.requestJson(
      `https://api.pinecone.io/indexes/${encodeURIComponent(this.indexName)}`,
      { method: 'GET' },
    );
    const record = asRecord(payload);
    const returnedName = stringField(record, 'name');
    const returnedHost = normalizeIndexHost(stringField(record, 'host'));
    const status = asRecord(record['status']);
    const ready = status['ready'] === true;
    const vectorType = stringField(record, 'vector_type');
    const dimension = integerField(record, 'dimension');
    const metric = stringField(record, 'metric');
    if (returnedName !== this.indexName || returnedHost !== this.indexHost) {
      throw new PineconeUploadError(
        'INDEX_MISMATCH',
        'PINECONE_INDEX and PINECONE_INDEX_HOST do not identify the same index',
      );
    }
    if (!ready) {
      throw new PineconeUploadError('INDEX_NOT_READY', `index ${this.indexName} is not ready`);
    }

    const embedValue = record['embed'];
    if (!isRecord(embedValue)) {
      return {
        name: returnedName,
        host: returnedHost,
        ready,
        vectorType,
        dimension,
        metric,
        integratedEmbedding: false,
      };
    }
    const embed = embedValue;
    const fieldMap = asRecord(embed['field_map'] ?? embed['fieldMap']);
    const textField = stringField(fieldMap, 'text');
    const embeddingModel = stringField(embed, 'model');

    if (textField !== 'chunk_text') {
      throw new PineconeUploadError(
        'INDEX_MISMATCH',
        `index field_map.text is ${textField}; expected chunk_text`,
      );
    }

    return {
      name: returnedName,
      host: returnedHost,
      ready,
      vectorType,
      dimension,
      metric,
      integratedEmbedding: true,
      embeddingModel,
      textField,
    };
  }

  async upsertTextRecords(
    namespace: string,
    records: readonly PineconeTextRecord[],
  ): Promise<void> {
    if (!namespace.trim()) {
      throw configurationError('Pinecone namespace must not be empty');
    }
    if (records.length === 0) {
      throw new PineconeUploadError('INVALID_LOCAL_DATA', 'cannot upsert an empty batch');
    }

    const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await this.requestJson(
      `${this.dataBaseUrl()}/records/namespaces/${encodeURIComponent(namespace)}/upsert`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
      },
    );
  }

  async upsertVectors(namespace: string, vectors: readonly PineconeVectorRecord[]): Promise<void> {
    if (!namespace.trim()) {
      throw configurationError('Pinecone namespace must not be empty');
    }
    if (vectors.length === 0) {
      throw new PineconeUploadError('INVALID_LOCAL_DATA', 'cannot upsert an empty vector batch');
    }

    const body = JSON.stringify({ vectors, namespace });
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > PINECONE_MAX_UPSERT_BYTES) {
      throw new PineconeUploadError(
        'INVALID_LOCAL_DATA',
        `vector upsert payload is ${bodyBytes} bytes; maximum is ${PINECONE_MAX_UPSERT_BYTES}`,
      );
    }

    const payload = await this.requestJson(`${this.dataBaseUrl()}/vectors/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const response = asRecord(payload);
    const upsertedCount = Number(response['upsertedCount'] ?? response['upserted_count']);
    if (upsertedCount !== vectors.length) {
      throw remoteResponseError(
        `Pinecone reported ${upsertedCount} upserts for a ${vectors.length}-vector batch`,
      );
    }
  }

  async describeNamespace(namespace: string): Promise<PineconeNamespaceDescription> {
    const payload = await this.requestJson(
      `${this.dataBaseUrl()}/namespaces/${encodeURIComponent(namespace)}`,
      { method: 'GET' },
    );
    const record = asRecord(payload);
    const name = stringField(record, 'name');
    const recordCountValue = record['record_count'] ?? record['recordCount'];
    const recordCount = Number(recordCountValue);
    if (!Number.isInteger(recordCount) || recordCount < 0) {
      throw remoteResponseError('namespace response contains an invalid record count');
    }
    return { name, recordCount };
  }

  async fetchRecords(
    namespace: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, PineconeFetchedRecord>> {
    if (ids.length === 0) {
      return new Map();
    }

    const url = new URL(`${this.dataBaseUrl()}/vectors/fetch`);
    url.searchParams.set('namespace', namespace);
    for (const id of ids) {
      url.searchParams.append('ids', id);
    }
    const payload = await this.requestJson(url.toString(), { method: 'GET' });
    const response = asRecord(payload);
    const vectors = asRecord(response['vectors']);
    const fetched = new Map<string, PineconeFetchedRecord>();

    for (const [id, value] of Object.entries(vectors)) {
      const vector = asRecord(value);
      fetched.set(id, {
        id: typeof vector['id'] === 'string' ? vector['id'] : id,
        metadata: asRecord(vector['metadata']),
      });
    }
    return fetched;
  }

  async queryByVector(
    namespace: string,
    vector: readonly number[],
    topK: number,
  ): Promise<readonly PineconeQueryMatch[]> {
    if (!namespace.trim()) {
      throw configurationError('Pinecone namespace must not be empty');
    }
    if (
      vector.length === 0 ||
      vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new PineconeUploadError(
        'INVALID_LOCAL_DATA',
        'query vector must contain finite numbers',
      );
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
      throw configurationError('query topK must be an integer from 1 to 100');
    }

    const payload = await this.requestJson(`${this.dataBaseUrl()}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace,
        vector,
        topK,
        includeValues: false,
        includeMetadata: true,
      }),
    });
    const response = asRecord(payload);
    const matchesValue = response['matches'];
    if (!Array.isArray(matchesValue)) {
      throw remoteResponseError('query response is missing matches');
    }
    return matchesValue.map((matchValue) => {
      const match = asRecord(matchValue);
      const id = stringField(match, 'id');
      const score = match['score'];
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw remoteResponseError(`query match ${id} has an invalid score`);
      }
      return { id, score, metadata: asRecord(match['metadata']) };
    });
  }

  private dataBaseUrl(): string {
    return `https://${this.indexHost}`;
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          ...init,
          headers: {
            Accept: 'application/json',
            'Api-Key': this.apiKey,
            'X-Pinecone-Api-Version': this.apiVersion,
            ...init.headers,
          },
        });
      } catch (error) {
        if (attempt === MAX_REQUEST_ATTEMPTS) {
          throw new PineconeUploadError(
            'REMOTE_REQUEST_FAILED',
            `network request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await retryDelay(attempt);
        continue;
      }

      const responseText = await response.text();
      if (response.ok) {
        if (!responseText.trim()) {
          return undefined;
        }
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          throw remoteResponseError(`HTTP ${response.status} returned invalid JSON`);
        }
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_REQUEST_ATTEMPTS) {
        await retryDelay(attempt, response.headers.get('retry-after'));
        continue;
      }

      const safeDetail = responseText.replace(/\s+/gu, ' ').trim().slice(0, 300);
      throw new PineconeUploadError(
        'REMOTE_REQUEST_FAILED',
        `HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`,
        response.status,
      );
    }

    throw new PineconeUploadError('REMOTE_REQUEST_FAILED', 'request attempts exhausted');
  }
}

export function normalizeIndexHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw configurationError('PINECONE_INDEX_HOST must not be empty');
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    throw configurationError('PINECONE_INDEX_HOST is not a valid host');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw configurationError('PINECONE_INDEX_HOST must be a bare HTTPS host');
  }
  return url.host;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw remoteResponseError('remote response has an invalid shape');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value) {
    throw remoteResponseError(`remote response is missing ${field}`);
  }
  return value;
}

function integerField(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw remoteResponseError(`remote response contains invalid ${field}`);
  }
  return value;
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

function remoteResponseError(reason: string): PineconeUploadError {
  return new PineconeUploadError('REMOTE_REQUEST_FAILED', reason);
}
