import { ChildChunk } from '../chunking';
import { IngestedParentRecord } from '../ingestion';
import { PineconeRestClient, normalizeIndexHost } from './client';
import { OpenAIEmbeddingClient, normalizeOpenAIBaseUrl } from './openai-embeddings';
import { MEDITATIONS_QUERY_SUITE } from './query-suite';
import {
  batchPineconeRecords,
  createPineconeRecords,
  createPineconeVectorRecords,
} from './records';
import { PineconeTextRecord, PineconeUploadError } from './types';

describe('Pinecone upload preparation', () => {
  it('joins child text with canonical parent metadata and provenance', () => {
    const parent = makeParent();
    const child = makeChild(parent);

    const records = createPineconeRecords([parent], [child]);

    expect(records).toEqual([
      {
        _id: child.id,
        chunk_text: child.text_search,
        record_type: 'child',
        parent_id: parent.id,
        parent_text: parent.text_search,
        parent_content_hash: parent.content_hash,
        canonical_ref: '1.1',
        book: 1,
        section: 1,
        child_index: 1,
        start_char: 0,
        end_char: parent.text_search.length,
        token_count: 12,
        work: 'Meditations',
        edition_id: 'long-1862',
        translator: 'George Long',
        translation_year: 1862,
        source_url: parent.source.url,
        source_page_title: parent.source.page_title,
        source_page_id: 123,
        source_revision_id: 456,
      },
    ]);
  });

  it('rejects missing parents, duplicate IDs, and untraceable child spans', () => {
    const parent = makeParent();
    const child = makeChild(parent);

    expect(() => createPineconeRecords([], [child])).toThrowError(PineconeUploadError);
    expect(() => createPineconeRecords([parent, parent], [child])).toThrowError(
      /duplicate parent ID/,
    );
    expect(() => createPineconeRecords([parent], [child, child])).toThrowError(
      /duplicate child ID/,
    );
    expect(() =>
      createPineconeRecords([parent], [{ ...child, text_search: 'not from the parent' }]),
    ).toThrowError(/not traceable/);
  });

  it('batches text records at Pinecone’s 96-record limit', () => {
    const records = Array.from({ length: 193 }, (_, index) => index);

    expect(batchPineconeRecords(records).map((batch) => batch.length)).toEqual([96, 96, 1]);
  });

  it('combines validated embeddings with child metadata for standard indexes', () => {
    const record = createPineconeRecords([makeParent()], [makeChild(makeParent())])[0];

    const vectors = createPineconeVectorRecords(
      [record],
      [[0.1, 0.2, 0.3]],
      'text-embedding-3-small',
      3,
    );
    const { _id: _recordId, ...expectedMetadata } = record;

    expect(vectors[0]).toEqual({
      id: record._id,
      values: [0.1, 0.2, 0.3],
      metadata: {
        ...expectedMetadata,
        embedding_model: 'text-embedding-3-small',
        embedding_dimensions: 3,
      },
    });
    expect('_id' in vectors[0].metadata).toBe(false);
  });
});

describe('Pinecone REST client', () => {
  it('normalizes a bare or HTTPS index host and rejects paths', () => {
    expect(normalizeIndexHost('example.svc.pinecone.io')).toBe('example.svc.pinecone.io');
    expect(normalizeIndexHost('https://example.svc.pinecone.io/')).toBe('example.svc.pinecone.io');
    expect(() => normalizeIndexHost('https://example.svc.pinecone.io/path')).toThrowError(
      /bare HTTPS host/,
    );
  });

  it('preflights index readiness, host identity, and chunk_text field mapping', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        name: 'meditations',
        host: 'meditations.svc.pinecone.io',
        vector_type: 'dense',
        dimension: 1024,
        metric: 'cosine',
        status: { ready: true, state: 'Ready' },
        embed: {
          model: 'llama-text-embed-v2',
          field_map: { text: 'chunk_text' },
        },
      }),
    );
    const client = makeClient(fetchImplementation);

    await expect(client.validateIndexConfiguration()).resolves.toEqual({
      name: 'meditations',
      host: 'meditations.svc.pinecone.io',
      ready: true,
      vectorType: 'dense',
      dimension: 1024,
      metric: 'cosine',
      integratedEmbedding: true,
      embeddingModel: 'llama-text-embed-v2',
      textField: 'chunk_text',
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0][0]).toBe(
      'https://api.pinecone.io/indexes/meditations',
    );
  });

  it('refuses to upload when the integrated embedding field map is incompatible', async () => {
    const client = makeClient(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        name: 'meditations',
        host: 'meditations.svc.pinecone.io',
        vector_type: 'dense',
        dimension: 1024,
        metric: 'cosine',
        status: { ready: true },
        embed: { model: 'llama-text-embed-v2', field_map: { text: 'content' } },
      }),
    );

    await expect(client.validateIndexConfiguration()).rejects.toThrowError(
      /field_map.text is content; expected chunk_text/,
    );
  });

  it('preflights a standard index without requiring integrated embedding', async () => {
    const client = makeClient(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        name: 'meditations',
        host: 'meditations.svc.pinecone.io',
        status: { ready: true },
        vector_type: 'dense',
        dimension: 1536,
        metric: 'cosine',
      }),
    );

    await expect(client.validateIndexConfiguration()).resolves.toEqual({
      name: 'meditations',
      host: 'meditations.svc.pinecone.io',
      ready: true,
      vectorType: 'dense',
      dimension: 1536,
      metric: 'cosine',
      integratedEmbedding: false,
    });
  });

  it('sends newline-delimited text records to the configured namespace', async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }),
    );
    const client = makeClient(fetchImplementation);
    const record = createPineconeRecords([makeParent()], [makeChild(makeParent())])[0];

    await client.upsertTextRecords('long-1862', [record]);

    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://meditations.svc.pinecone.io/records/namespaces/long-1862/upsert');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-ndjson');
    expect(String(init?.body)).toBe(`${JSON.stringify(record)}\n`);
  });

  it('upserts raw vectors and metadata to a standard index', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ upsertedCount: 1 }),
    );
    const client = makeClient(fetchImplementation);
    const record = createPineconeRecords([makeParent()], [makeChild(makeParent())])[0];
    const vector = createPineconeVectorRecords([record], [[0.1, 0.2]], 'test-model', 2)[0];

    await client.upsertVectors('long-1862', [vector]);

    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://meditations.svc.pinecone.io/vectors/upsert');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      vectors: [vector],
      namespace: 'long-1862',
    });
  });

  it('describes a namespace and fetches sample record metadata for verification', async () => {
    const fetchImplementation = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ name: 'long-1862', record_count: 557 }))
      .mockResolvedValueOnce(
        jsonResponse({
          namespace: 'long-1862',
          vectors: {
            'child-c01': {
              id: 'child-c01',
              metadata: { parent_id: 'parent-1', canonical_ref: '1.1' },
            },
          },
        }),
      );
    const client = makeClient(fetchImplementation);

    await expect(client.describeNamespace('long-1862')).resolves.toEqual({
      name: 'long-1862',
      recordCount: 557,
    });
    const records = await client.fetchRecords('long-1862', ['child-c01']);
    expect(records.get('child-c01')).toEqual({
      id: 'child-c01',
      metadata: { parent_id: 'parent-1', canonical_ref: '1.1' },
    });
  });

  it('queries by vector without returning vector values', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        namespace: 'long-1862',
        matches: [
          {
            id: 'child-c01',
            score: 0.72,
            metadata: { canonical_ref: '1.1', chunk_text: 'From my grandfather...' },
          },
        ],
      }),
    );
    const client = makeClient(fetchImplementation);

    await expect(client.queryByVector('long-1862', [0.1, 0.2], 3)).resolves.toEqual([
      {
        id: 'child-c01',
        score: 0.72,
        metadata: { canonical_ref: '1.1', chunk_text: 'From my grandfather...' },
      },
    ]);
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://meditations.svc.pinecone.io/query');
    expect(JSON.parse(String(init?.body))).toEqual({
      namespace: 'long-1862',
      vector: [0.1, 0.2],
      topK: 3,
      includeValues: false,
      includeMetadata: true,
    });
  });
});

describe('OpenAI embeddings client', () => {
  it('normalizes an HTTPS base URL and rejects embedded credentials', () => {
    expect(normalizeOpenAIBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(() => normalizeOpenAIBaseUrl('https://user:secret@example.com/v1')).toThrowError(
      /without credentials/,
    );
  });

  it('requests ordered float embeddings with an explicit dimension', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        object: 'list',
        model: 'text-embedding-3-small',
        data: [
          { object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }),
    );
    const client = new OpenAIEmbeddingClient({
      apiKey: 'test-openai-key',
      dimensions: 3,
      fetchImplementation,
    });

    await expect(client.createEmbeddings(['first', 'second'])).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-openai-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
      encoding_format: 'float',
      dimensions: 3,
    });
  });

  it('rejects embeddings whose dimensions do not match the index', async () => {
    const client = new OpenAIEmbeddingClient({
      apiKey: 'test-openai-key',
      dimensions: 3,
      fetchImplementation: async () =>
        jsonResponse({
          model: 'text-embedding-3-small',
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
    });

    await expect(client.createEmbeddings(['text'])).rejects.toThrowError(
      /2 dimensions; expected 3/,
    );
  });
});

describe('Meditations query suite', () => {
  it('contains 20 unique, non-empty scenarios including the requested examples', () => {
    expect(MEDITATIONS_QUERY_SUITE).toHaveLength(20);
    expect(new Set(MEDITATIONS_QUERY_SUITE.map((query) => query.id)).size).toBe(20);
    expect(MEDITATIONS_QUERY_SUITE.map((query) => query.text)).toEqual(
      expect.arrayContaining(["I'm hungry.", 'I want to fight someone.', "I'm happy."]),
    );
    expect(MEDITATIONS_QUERY_SUITE.every((query) => query.text.trim().length > 0)).toBe(true);
  });
});

function makeClient(fetchImplementation: typeof fetch): PineconeRestClient {
  return new PineconeRestClient({
    apiKey: 'test-api-key',
    indexName: 'meditations',
    indexHost: 'meditations.svc.pinecone.io',
    fetchImplementation,
  });
}

function makeParent(): IngestedParentRecord {
  const text = 'From my grandfather Verus I learned good morals and government of my temper.';
  return {
    id: 'meditations-long-1862-b01-s001',
    type: 'parent',
    work: 'Meditations',
    canonical_ref: '1.1',
    edition: {
      translator: 'George Long',
      year: 1862,
      edition_id: 'long-1862',
    },
    book: 1,
    section: 1,
    text_display: text,
    text_search: text,
    content_hash: `sha256:${'a'.repeat(64)}`,
    source: {
      url: 'https://en.wikisource.org/wiki/Work/Book_I',
      page_title: 'Work/Book I',
      page_id: 123,
      revision_id: 456,
    },
  };
}

function makeChild(parent: IngestedParentRecord): ChildChunk {
  return {
    id: `${parent.id}-c01`,
    type: 'child',
    parent_id: parent.id,
    canonical_ref: parent.canonical_ref,
    child_index: 1,
    start_char: 0,
    end_char: parent.text_search.length,
    token_count: 12,
    text_search: parent.text_search,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
