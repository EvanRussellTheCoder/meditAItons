import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  MEDITATIONS_QUERY_SUITE,
  OPENAI_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  PineconeQueryMatch,
  PineconeRestClient,
  PineconeUploadError,
} from '../src/app/core/pinecone';
import {
  ConversationRouter,
  DEFAULT_OPENAI_MODERATION_MODEL,
  DEFAULT_OPENAI_ROUTER_MODEL,
  OpenAIModerationClient,
  OpenAIScopeClassifier,
  RoutingDecision,
} from '../src/app/core/routing';

const DEFAULT_NAMESPACE = 'long-1862';
const DEFAULT_TOP_K = 3;
const MAX_TOP_K = 20;
const QUERY_CONCURRENCY = 4;

interface QueryOptions {
  readonly queries: readonly { readonly id: string; readonly text: string }[];
  readonly suite: boolean;
  readonly topK: number;
  readonly namespaceOverride?: string;
  readonly json: boolean;
  readonly help: boolean;
}

interface QueryResult {
  readonly id: string;
  readonly query: string;
  readonly routing: RoutingDecision;
  readonly matches: readonly PineconeQueryMatch[];
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  loadLocalEnvironment();

  const namespace = requiredValue(
    options.namespaceOverride ?? process.env['PINECONE_NAMESPACE'] ?? DEFAULT_NAMESPACE,
    'PINECONE_NAMESPACE',
  );
  const embeddingModel =
    process.env['OPENAI_EMBEDDING_MODEL']?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
  const openAIApiKey = requiredEnvironmentValue('OPENAI_API_KEY');
  const openAIBaseUrl = process.env['OPENAI_BASE_URL'];
  const router = new ConversationRouter({
    moderation: new OpenAIModerationClient({
      apiKey: openAIApiKey,
      baseUrl: openAIBaseUrl,
      model: process.env['OPENAI_MODERATION_MODEL']?.trim() || DEFAULT_OPENAI_MODERATION_MODEL,
    }),
    classifier: new OpenAIScopeClassifier({
      apiKey: openAIApiKey,
      baseUrl: openAIBaseUrl,
      model: process.env['OPENAI_ROUTER_MODEL']?.trim() || DEFAULT_OPENAI_ROUTER_MODEL,
    }),
  });

  // Scope and safety routing must complete before any embedding or Pinecone request.
  const routingDecisions = await mapWithConcurrency(
    options.queries,
    QUERY_CONCURRENCY,
    async (query) => router.route({ message: query.text }),
  );
  const retrievalIndexes = options.queries
    .map((_query, index) => index)
    .filter((index) => routingDecisions[index].retrieve);
  const matchesByQueryIndex = new Map<number, readonly PineconeQueryMatch[]>();

  if (retrievalIndexes.length > 0) {
    const embeddingsClient = new OpenAIEmbeddingClient({
      apiKey: openAIApiKey,
      baseUrl: openAIBaseUrl,
      model: embeddingModel,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    });
    const pineconeClient = new PineconeRestClient({
      apiKey: requiredEnvironmentValue('PINECONE_API_KEY'),
      indexHost: requiredEnvironmentValue('PINECONE_INDEX_HOST'),
      indexName: requiredEnvironmentValue('PINECONE_INDEX'),
    });

    const index = await pineconeClient.validateIndexConfiguration();
    if (!index) {
      throw configurationError('PINECONE_INDEX is required for the query safety preflight');
    }
    if (
      index.integratedEmbedding ||
      index.vectorType !== 'dense' ||
      index.dimension !== OPENAI_EMBEDDING_DIMENSIONS
    ) {
      throw configurationError(
        `query command expected a standard dense ${OPENAI_EMBEDDING_DIMENSIONS}-dimensional index`,
      );
    }

    const embeddings = await embeddingsClient.createEmbeddings(
      retrievalIndexes.map((queryIndex) => options.queries[queryIndex].text),
    );
    const retrievedMatches = await mapWithConcurrency(
      retrievalIndexes,
      QUERY_CONCURRENCY,
      async (queryIndex, indexInList): Promise<readonly PineconeQueryMatch[]> => {
        const matches = await pineconeClient.queryByVector(
          namespace,
          embeddings[indexInList],
          options.topK,
        );
        validateMatchEmbeddings(matches, embeddingModel, OPENAI_EMBEDDING_DIMENSIONS);
        return matches;
      },
    );
    retrievalIndexes.forEach((queryIndex, index) => {
      matchesByQueryIndex.set(queryIndex, retrievedMatches[index]);
    });
  }

  const results: readonly QueryResult[] = options.queries.map((query, index) => ({
    id: query.id,
    query: query.text,
    routing: routingDecisions[index],
    matches: matchesByQueryIndex.get(index) ?? [],
  }));

  if (options.json) {
    console.log(JSON.stringify({ namespace, embeddingModel, results }, null, 2));
    return;
  }
  if (options.suite) {
    printSuiteResults(results);
  } else {
    printDetailedResult(results[0], namespace, embeddingModel);
  }
}

function parseArguments(argumentsList: readonly string[]): QueryOptions {
  let suite = false;
  let topK = DEFAULT_TOP_K;
  let namespaceOverride: string | undefined;
  let json = false;
  let help = false;
  const promptParts: string[] = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--suite') {
      suite = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--top-k' || argument === '--namespace') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw configurationError(`${argument} requires a value`);
      }
      if (argument === '--top-k') {
        topK = Number(value);
      } else {
        namespaceOverride = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw configurationError(`unknown argument ${argument}`);
    }
    promptParts.push(argument);
  }

  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw configurationError(`--top-k must be an integer from 1 to ${MAX_TOP_K}`);
  }
  if (suite && promptParts.length > 0) {
    throw configurationError('--suite cannot be combined with a custom prompt');
  }
  if (!suite && promptParts.join(' ').trim().length === 0 && !help) {
    throw configurationError('provide a prompt or use --suite');
  }

  const prompt = promptParts.join(' ').trim();
  return {
    queries: suite ? MEDITATIONS_QUERY_SUITE : [{ id: 'custom', text: prompt }],
    suite,
    topK,
    namespaceOverride,
    json,
    help,
  };
}

function printHelp(): void {
  console.log(`Usage:
  npm run pinecone:query -- "I'm hungry"
  npm run pinecone:query -- --top-k 5 "I'm anxious about tomorrow"
  npm run pinecone:query -- --json "I want revenge"
  npm run pinecone:query:test

Options:
  --top-k N        Return 1-${MAX_TOP_K} matches (default: ${DEFAULT_TOP_K})
  --namespace NAME Override PINECONE_NAMESPACE (default: ${DEFAULT_NAMESPACE})
  --json           Print machine-readable full results
  --suite          Run the checked-in 20-query smoke suite`);
}

function printDetailedResult(result: QueryResult, namespace: string, embeddingModel: string): void {
  console.log(`Query: ${result.query}`);
  console.log(
    `Route: ${result.routing.route} (${result.routing.source}/${result.routing.reason}); ` +
      `retrieval=${result.routing.retrieve ? 'allowed' : 'skipped'}`,
  );
  if (!result.routing.retrieve) {
    console.log(`Response: ${result.routing.userMessage}`);
    return;
  }
  console.log(`Namespace: ${namespace}; embedding model: ${embeddingModel}`);
  for (const [index, match] of result.matches.entries()) {
    console.log(
      `\n${index + 1}. Meditations ${metadataString(match, 'canonical_ref')} ` +
        `(score ${match.score.toFixed(4)})`,
    );
    console.log(`   Child: ${truncate(metadataString(match, 'chunk_text'), 500)}`);
    console.log(`   Parent: ${truncate(metadataString(match, 'parent_text'), 700)}`);
    console.log(`   Source: ${metadataString(match, 'source_url')}`);
  }
}

function printSuiteResults(results: readonly QueryResult[]): void {
  const topReferences = new Set<string>();
  const routeCounts = new Map<string, number>();
  for (const [index, result] of results.entries()) {
    console.log(`\n[${index + 1}/${results.length}] ${result.query}`);
    routeCounts.set(result.routing.route, (routeCounts.get(result.routing.route) ?? 0) + 1);
    console.log(
      `  Route: ${result.routing.route} (${result.routing.source}/${result.routing.reason}); ` +
        `retrieval=${result.routing.retrieve ? 'allowed' : 'skipped'}`,
    );
    if (!result.routing.retrieve) {
      console.log(`  Response: ${result.routing.userMessage}`);
      continue;
    }
    for (const [rank, match] of result.matches.entries()) {
      const reference = metadataString(match, 'canonical_ref');
      if (rank === 0) {
        topReferences.add(reference);
      }
      console.log(
        `  ${rank + 1}. ${reference} | ${match.score.toFixed(4)} | ` +
          truncate(metadataString(match, 'chunk_text'), 180),
      );
    }
  }
  console.log(
    `\nCompleted ${results.length} queries; ` +
      `${topReferences.size} distinct first-ranked references; routes: ` +
      [...routeCounts.entries()].map(([route, count]) => `${route}=${count}`).join(', ') +
      '.',
  );
}

function validateMatchEmbeddings(
  matches: readonly PineconeQueryMatch[],
  expectedModel: string,
  expectedDimensions: number,
): void {
  if (matches.length === 0) {
    throw new PineconeUploadError('VERIFICATION_FAILED', 'query returned no matches');
  }
  for (const match of matches) {
    if (
      match.metadata['embedding_model'] !== expectedModel ||
      match.metadata['embedding_dimensions'] !== expectedDimensions
    ) {
      throw new PineconeUploadError(
        'VERIFICATION_FAILED',
        `query match ${match.id} was embedded with an unexpected model or dimension`,
      );
    }
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function metadataString(match: PineconeQueryMatch, field: string): string {
  const value = match.metadata[field];
  return typeof value === 'string' && value ? value : '[missing]';
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1).trimEnd()}…`;
}

function loadLocalEnvironment(): void {
  const environmentPath = resolve('.env');
  if (existsSync(environmentPath)) {
    process.loadEnvFile(environmentPath);
  }
}

function requiredEnvironmentValue(name: string): string {
  return requiredValue(process.env[name], name);
}

function requiredValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw configurationError(`${name} must be set in .env or the process environment`);
  }
  return trimmed;
}

function configurationError(reason: string): PineconeUploadError {
  return new PineconeUploadError('INVALID_CONFIGURATION', reason);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
