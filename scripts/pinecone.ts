import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import { ChildChunk } from '../src/app/core/chunking';
import { IngestedParentRecord } from '../src/app/core/ingestion';
import {
  batchPineconeRecords,
  createPineconeRecords,
  createPineconeVectorRecords,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_BATCH_SIZE,
  OPENAI_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  PineconeIndexDescription,
  PineconeRestClient,
  PineconeTextRecord,
  PineconeUploadError,
} from '../src/app/core/pinecone';

const DEFAULT_DATA_DIRECTORY = 'data/generated';
const DEFAULT_NAMESPACE = 'long-1862';
const MANIFEST_FILE = 'meditations-long-1862.manifest.json';
const VERIFICATION_ATTEMPTS = 15;
const VERIFICATION_DELAY_MILLISECONDS = 2_000;
const PINECONE_VECTOR_BATCH_SIZE = 20;

type CommandMode = 'upsert' | 'verify';

interface CommandOptions {
  readonly mode: CommandMode;
  readonly dataDirectory: string;
  readonly namespaceOverride?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
}

interface ManifestFileEntry {
  readonly path: string;
  readonly sha256: string;
}

interface IngestionManifest {
  readonly edition: { readonly edition_id: string };
  readonly totals: { readonly parents: number; readonly children: number };
  readonly files: {
    readonly parents: ManifestFileEntry;
    readonly children: ManifestFileEntry;
  };
}

interface LocalUploadData {
  readonly manifest: IngestionManifest;
  readonly records: readonly PineconeTextRecord[];
}

/**
 * Plain-English pseudocode for publishing the corpus:
 * 1. Validate the manifest, file hashes, parent/child links, environment, and target index.
 * 2. For a standard index, embed each child's chunk_text and attach its traceable metadata.
 * 3. Upsert conservative batches into one namespace; an integrated index embeds text itself.
 * 4. Wait for Pinecone consistency, then verify the exact count and representative records.
 * 5. Never delete remote records as an automatic repair.
 */
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
  const apiKey = requiredEnvironmentValue('PINECONE_API_KEY');
  const indexHost = requiredEnvironmentValue('PINECONE_INDEX_HOST');
  const indexName = requiredEnvironmentValue('PINECONE_INDEX');
  const localData = await loadLocalUploadData(options.dataDirectory);
  const textBatches = batchPineconeRecords(localData.records);
  const client = new PineconeRestClient({ apiKey, indexHost, indexName });

  console.log(
    `Validated ${localData.records.length} child records from ${options.dataDirectory} ` +
      `(namespace ${namespace}).`,
  );

  if (options.dryRun) {
    console.log('Dry run complete. No Pinecone requests were made.');
    return;
  }

  const index = await client.validateIndexConfiguration();
  if (!index) {
    throw configurationError('PINECONE_INDEX is required for the safety preflight');
  }
  const embeddingModel =
    process.env['OPENAI_EMBEDDING_MODEL']?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
  if (index.integratedEmbedding) {
    console.log(
      `Preflight passed for integrated index ${index.name} ` +
        `(model ${index.embeddingModel}; text field ${index.textField}).`,
    );
  } else {
    validateStandardIndex(index);
    console.log(
      `Preflight passed for standard index ${index.name} ` +
        `(${index.dimension} dimensions; ${index.metric}; embedding model ${embeddingModel}).`,
    );
  }

  if (options.mode === 'upsert') {
    if (index.integratedEmbedding) {
      for (const [indexInList, batch] of textBatches.entries()) {
        await client.upsertTextRecords(namespace, batch);
        console.log(
          `Uploaded text batch ${indexInList + 1}/${textBatches.length} ` +
            `(${batch.length} records).`,
        );
      }
    } else {
      const embeddingsClient = new OpenAIEmbeddingClient({
        apiKey: requiredEnvironmentValue('OPENAI_API_KEY'),
        baseUrl: process.env['OPENAI_BASE_URL'],
        model: embeddingModel,
        dimensions: index.dimension,
      });
      await uploadStandardVectors(client, embeddingsClient, namespace, localData.records);
    }
    await verifyRemoteData(
      client,
      namespace,
      localData.records,
      true,
      index.integratedEmbedding
        ? undefined
        : { model: embeddingModel, dimensions: index.dimension },
    );
    console.log(`Upsert and verification passed for ${localData.records.length} records.`);
    return;
  }

  await verifyRemoteData(
    client,
    namespace,
    localData.records,
    false,
    index.integratedEmbedding ? undefined : { model: embeddingModel, dimensions: index.dimension },
  );
  console.log(`Verification passed for ${localData.records.length} records.`);
}

function parseArguments(argumentsList: readonly string[]): CommandOptions {
  const modeValue = argumentsList[0];
  if (modeValue !== 'upsert' && modeValue !== 'verify') {
    throw configurationError('first argument must be upsert or verify');
  }

  let dataDirectory = DEFAULT_DATA_DIRECTORY;
  let namespaceOverride: string | undefined;
  let dryRun = false;
  let help = false;

  for (let index = 1; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--data-dir' || argument === '--namespace') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) {
        throw configurationError(`${argument} requires a value`);
      }
      if (argument === '--data-dir') {
        dataDirectory = value;
      } else {
        namespaceOverride = value;
      }
      index += 1;
      continue;
    }
    throw configurationError(`unknown argument ${argument}`);
  }

  if (modeValue === 'verify' && dryRun) {
    throw configurationError('--dry-run is only valid for the upsert command');
  }
  return { mode: modeValue, dataDirectory, namespaceOverride, dryRun, help };
}

function printHelp(): void {
  console.log(`Usage:
  npm run pinecone:upsert [-- --dry-run] [-- --namespace NAME] [-- --data-dir PATH]
  npm run pinecone:verify [-- --namespace NAME] [-- --data-dir PATH]

The upsert command validates the generated JSONL files and manifest, checks the
Pinecone index, embeds text with OpenAI for a standard 1536-dimensional index (or
uses Pinecone embedding for an integrated index), uploads the child records, then
verifies the record count and three sample records.

Required environment variables:
  PINECONE_API_KEY
  PINECONE_INDEX
  PINECONE_INDEX_HOST
  OPENAI_API_KEY (standard indexes only)

Optional environment variables:
  PINECONE_NAMESPACE (default: ${DEFAULT_NAMESPACE})
  OPENAI_EMBEDDING_MODEL (default: ${DEFAULT_OPENAI_EMBEDDING_MODEL})
  OPENAI_BASE_URL (default: https://api.openai.com/v1)`);
}

function validateStandardIndex(index: PineconeIndexDescription): void {
  if (
    index.vectorType !== 'dense' ||
    index.dimension !== OPENAI_EMBEDDING_DIMENSIONS ||
    !['cosine', 'dotproduct'].includes(index.metric.toLowerCase())
  ) {
    throw new PineconeUploadError(
      'INDEX_MISMATCH',
      `standard index ${index.name} is ${index.vectorType}/${index.dimension}/${index.metric}; ` +
        `expected dense/${OPENAI_EMBEDDING_DIMENSIONS}/cosine-or-dotproduct for OpenAI embeddings`,
    );
  }
}

async function uploadStandardVectors(
  pineconeClient: PineconeRestClient,
  embeddingsClient: OpenAIEmbeddingClient,
  namespace: string,
  records: readonly PineconeTextRecord[],
): Promise<void> {
  const embeddingBatches = batchPineconeRecords(records, OPENAI_EMBEDDING_BATCH_SIZE);
  const totalVectorBatches = embeddingBatches.reduce(
    (total, batch) => total + Math.ceil(batch.length / PINECONE_VECTOR_BATCH_SIZE),
    0,
  );
  let uploadedVectorBatches = 0;

  for (const [embeddingBatchIndex, recordBatch] of embeddingBatches.entries()) {
    const embeddings = await embeddingsClient.createEmbeddings(
      recordBatch.map((record) => record.chunk_text),
    );
    console.log(
      `Embedded batch ${embeddingBatchIndex + 1}/${embeddingBatches.length} ` +
        `(${recordBatch.length} records).`,
    );
    const vectors = createPineconeVectorRecords(
      recordBatch,
      embeddings,
      embeddingsClient.model,
      embeddingsClient.dimensions,
    );
    const vectorBatches = batchPineconeRecords(vectors, PINECONE_VECTOR_BATCH_SIZE);
    for (const vectorBatch of vectorBatches) {
      await pineconeClient.upsertVectors(namespace, vectorBatch);
      uploadedVectorBatches += 1;
      console.log(
        `Uploaded vector batch ${uploadedVectorBatches}/${totalVectorBatches} ` +
          `(${vectorBatch.length} records).`,
      );
    }
  }
}

function loadLocalEnvironment(): void {
  const environmentPath = resolve('.env');
  if (existsSync(environmentPath)) {
    process.loadEnvFile(environmentPath);
  }
}

async function loadLocalUploadData(dataDirectoryValue: string): Promise<LocalUploadData> {
  const dataDirectory = resolve(dataDirectoryValue);
  const manifestPath = resolveWithin(dataDirectory, MANIFEST_FILE);
  const manifestText = await readRequiredFile(manifestPath);
  const manifest = parseManifest(manifestText);
  const parentsPath = resolveWithin(dataDirectory, manifest.files.parents.path);
  const childrenPath = resolveWithin(dataDirectory, manifest.files.children.path);
  const [parentsText, childrenText] = await Promise.all([
    readRequiredFile(parentsPath),
    readRequiredFile(childrenPath),
  ]);

  validateFileHash('parents', parentsText, manifest.files.parents.sha256);
  validateFileHash('children', childrenText, manifest.files.children.sha256);
  const parents = parseJsonLines<IngestedParentRecord>('parents', parentsText);
  const children = parseJsonLines<ChildChunk>('children', childrenText);

  if (parents.length !== manifest.totals.parents) {
    throw invalidData(
      `parent count ${parents.length} does not match manifest count ${manifest.totals.parents}`,
    );
  }
  if (children.length !== manifest.totals.children) {
    throw invalidData(
      `child count ${children.length} does not match manifest count ${manifest.totals.children}`,
    );
  }

  const records = createPineconeRecords(parents, children);
  for (const record of records) {
    if (record.edition_id !== manifest.edition.edition_id) {
      throw invalidData(
        `record ${record._id} edition ${record.edition_id} does not match the manifest`,
      );
    }
  }
  return { manifest, records };
}

function parseManifest(text: string): IngestionManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidData(`${MANIFEST_FILE} is not valid JSON`);
  }
  const manifest = objectValue(value, 'manifest');
  const edition = objectValue(manifest['edition'], 'manifest edition');
  const totals = objectValue(manifest['totals'], 'manifest totals');
  const files = objectValue(manifest['files'], 'manifest files');
  const parentsFile = parseManifestFile(files['parents'], 'parents');
  const childrenFile = parseManifestFile(files['children'], 'children');
  const editionId = stringValue(edition['edition_id'], 'manifest edition_id');
  const parentCount = nonnegativeInteger(totals['parents'], 'manifest parent total');
  const childCount = nonnegativeInteger(totals['children'], 'manifest child total');

  return {
    edition: { edition_id: editionId },
    totals: { parents: parentCount, children: childCount },
    files: { parents: parentsFile, children: childrenFile },
  };
}

function parseManifestFile(value: unknown, label: string): ManifestFileEntry {
  const entry = objectValue(value, `manifest ${label} file`);
  return {
    path: stringValue(entry['path'], `manifest ${label} path`),
    sha256: stringValue(entry['sha256'], `manifest ${label} sha256`),
  };
}

function parseJsonLines<T>(label: string, text: string): readonly T[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      objectValue(value, `${label} line ${index + 1}`);
      return value as T;
    } catch (error) {
      if (error instanceof PineconeUploadError) {
        throw error;
      }
      throw invalidData(`${label} line ${index + 1} is not valid JSON`);
    }
  });
}

function validateFileHash(label: string, text: string, expectedHash: string): void {
  const actualHash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  if (actualHash !== expectedHash) {
    throw invalidData(`${label} JSONL SHA-256 does not match the manifest`);
  }
}

async function verifyRemoteData(
  client: PineconeRestClient,
  namespace: string,
  expectedRecords: readonly PineconeTextRecord[],
  waitForConsistency: boolean,
  expectedEmbedding?: { readonly model: string; readonly dimensions: number },
): Promise<void> {
  const attempts = waitForConsistency ? VERIFICATION_ATTEMPTS : 1;
  let actualCount: number | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const namespaceDescription = await client.describeNamespace(namespace);
      actualCount = namespaceDescription.recordCount;
    } catch (error) {
      if (
        !waitForConsistency ||
        !(error instanceof PineconeUploadError) ||
        error.httpStatus !== 404
      ) {
        throw error;
      }
      actualCount = 0;
    }

    if (actualCount === expectedRecords.length) {
      break;
    }
    if (actualCount > expectedRecords.length) {
      throw verificationError(
        `namespace contains ${actualCount} records; expected exactly ${expectedRecords.length}. ` +
          'No records were deleted automatically.',
      );
    }
    if (attempt < attempts) {
      await delay(VERIFICATION_DELAY_MILLISECONDS);
    }
  }

  if (actualCount !== expectedRecords.length) {
    throw verificationError(
      `namespace contains ${actualCount ?? 'an unknown number of'} records; ` +
        `expected exactly ${expectedRecords.length}`,
    );
  }

  const samples = selectSampleRecords(expectedRecords);
  const fetched = await client.fetchRecords(
    namespace,
    samples.map((record) => record._id),
  );
  for (const expected of samples) {
    const actual = fetched.get(expected._id);
    if (!actual) {
      throw verificationError(`sample record ${expected._id} was not returned by Pinecone`);
    }
    for (const field of ['parent_id', 'canonical_ref', 'edition_id'] as const) {
      if (actual.metadata[field] !== expected[field]) {
        throw verificationError(`sample record ${expected._id} has incorrect ${field}`);
      }
    }
    if (
      expectedEmbedding &&
      (actual.metadata['embedding_model'] !== expectedEmbedding.model ||
        actual.metadata['embedding_dimensions'] !== expectedEmbedding.dimensions)
    ) {
      throw verificationError(`sample record ${expected._id} has incorrect embedding metadata`);
    }
  }
}

function selectSampleRecords(
  records: readonly PineconeTextRecord[],
): readonly PineconeTextRecord[] {
  if (records.length === 0) {
    throw invalidData('cannot verify an empty local dataset');
  }
  const indexes = new Set([0, Math.floor(records.length / 2), records.length - 1]);
  return [...indexes].map((index) => records[index]);
}

function resolveWithin(directory: string, pathValue: string): string {
  if (isAbsolute(pathValue)) {
    throw invalidData(`manifest file path must be relative: ${pathValue}`);
  }
  const resolvedPath = resolve(directory, pathValue);
  const relativePath = relative(directory, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw invalidData(`manifest file path escapes the data directory: ${pathValue}`);
  }
  return resolvedPath;
}

async function readRequiredFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw invalidData(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
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

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidData(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw invalidData(`${label} must be a non-empty string`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidData(`${label} must be a nonnegative integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function configurationError(reason: string): PineconeUploadError {
  return new PineconeUploadError('INVALID_CONFIGURATION', reason);
}

function invalidData(reason: string): PineconeUploadError {
  return new PineconeUploadError('INVALID_LOCAL_DATA', reason);
}

function verificationError(reason: string): PineconeUploadError {
  return new PineconeUploadError('VERIFICATION_FAILED', reason);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
