import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import {
  CHUNKING_CONFIG,
  CHUNKING_VERSION,
  ChildChunk,
  chunkParents,
} from '../src/app/core/chunking';
import {
  EXPECTED_SECTIONS_BY_BOOK,
  IngestedParentRecord,
  MediaWikiSource,
  buildParentRecords,
  parseMeditationsBookDocument,
  parseSourceManifest,
  romanBookNumber,
} from '../src/app/core/ingestion';

const DEFAULT_SOURCES = 'data/sources/meditations-wiki-urls-georgelang.txt';
const DEFAULT_OUTPUT_DIRECTORY = 'data/generated';
const PARENT_FILENAME = 'meditations-long-1862.parents.jsonl';
const CHILD_FILENAME = 'meditations-long-1862.children.jsonl';
const MANIFEST_FILENAME = 'meditations-long-1862.manifest.json';
const MAX_FETCH_ATTEMPTS = 4;
const INTER_REQUEST_DELAY_MS = 250;
const USER_AGENT = 'MeditAItons/1.0 (educational Meditations ingestion pipeline)';

interface CliOptions {
  readonly sourcesPath: string;
  readonly outputDirectory: string;
}

interface MediaWikiParseResponse {
  readonly parse?: {
    readonly title?: unknown;
    readonly pageid?: unknown;
    readonly revid?: unknown;
    readonly text?: unknown;
  };
  readonly error?: {
    readonly code?: unknown;
    readonly info?: unknown;
  };
}

interface FetchedPage {
  readonly title: string;
  readonly pageId: number;
  readonly revisionId: number;
  readonly html: string;
}

/**
 * Plain-English pseudocode for the offline ingestion flow:
 * 1. Read and validate the twelve Wikisource URLs.
 * 2. Ask MediaWiki for each page's rendered HTML and revision identity.
 * 3. Parse every numbered verse into one immutable canonical parent record.
 * 4. Split each parent into smaller retrieval children without changing its wording.
 * 5. Validate parent/child traceability, then write JSONL files and a hashed manifest.
 */
async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = process.cwd();
  const sourcesPath = path.resolve(projectRoot, options.sourcesPath);
  const outputDirectory = path.resolve(projectRoot, options.outputDirectory);
  const sourceContents = await readFile(sourcesPath, 'utf8');
  const sources = parseSourceManifest(sourceContents);
  const parents: IngestedParentRecord[] = [];
  const sourceManifest: Array<{
    book: number;
    url: string;
    page_title: string;
    page_id: number;
    revision_id: number;
    section_count: number;
  }> = [];

  for (const [index, source] of sources.entries()) {
    console.log(
      `[${index + 1}/${sources.length}] Fetching Book ${romanBookNumber(source.book)} from Wikisource`,
    );
    const fetched = await fetchMediaWikiPage(source);
    const dom = new JSDOM(fetched.html);

    try {
      const parsed = parseMeditationsBookDocument(dom.window.document, {
        source,
        pageId: fetched.pageId,
        revisionId: fetched.revisionId,
        resolvedTitle: fetched.title,
      });
      parents.push(...buildParentRecords(parsed, sha256));
      sourceManifest.push({
        book: source.book,
        url: source.url,
        page_title: fetched.title,
        page_id: fetched.pageId,
        revision_id: fetched.revisionId,
        section_count: parsed.sections.length,
      });
      console.log(`  Parsed ${parsed.sections.length} canonical sections`);
    } finally {
      dom.window.close();
    }

    if (index < sources.length - 1) {
      await delay(INTER_REQUEST_DELAY_MS);
    }
  }

  const chunkingResults = chunkParents(parents);
  const children = chunkingResults.flatMap((result) => result.children);
  validateDataset(parents, children);

  const parentJsonl = toJsonLines(parents);
  const childJsonl = toJsonLines(children);
  const manifest = {
    schema_version: 'meditations-ingestion-v1',
    work: 'Meditations',
    edition: {
      translator: 'George Long',
      year: 1862,
      edition_id: 'long-1862',
    },
    source_manifest: path.relative(projectRoot, sourcesPath),
    source_api: 'MediaWiki Action API action=parse',
    source_license: 'See the license and attribution terms on each Wikisource source page.',
    chunking_version: CHUNKING_VERSION,
    tokenizer: 'unicode-word-v1',
    chunking_config: CHUNKING_CONFIG,
    totals: {
      books: sourceManifest.length,
      parents: parents.length,
      children: children.length,
    },
    books: sourceManifest,
    files: {
      parents: {
        path: PARENT_FILENAME,
        sha256: sha256(parentJsonl),
      },
      children: {
        path: CHILD_FILENAME,
        sha256: sha256(childJsonl),
      },
    },
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeAtomic(path.join(outputDirectory, PARENT_FILENAME), parentJsonl),
    writeAtomic(path.join(outputDirectory, CHILD_FILENAME), childJsonl),
    writeAtomic(
      path.join(outputDirectory, MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);

  console.log('');
  console.log(`Created ${parents.length} canonical parents and ${children.length} children.`);
  console.log(`Output directory: ${outputDirectory}`);
}

async function fetchMediaWikiPage(source: MediaWikiSource): Promise<FetchedPage> {
  const requestUrl = new URL(source.apiUrl);
  requestUrl.searchParams.set('action', 'parse');
  requestUrl.searchParams.set('page', source.pageTitle);
  requestUrl.searchParams.set('prop', 'text|revid');
  requestUrl.searchParams.set('redirects', '1');
  requestUrl.searchParams.set('format', 'json');
  requestUrl.searchParams.set('formatversion', '2');
  requestUrl.searchParams.set('origin', '*');

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: 'application/json',
          'Api-User-Agent': USER_AGENT,
          'User-Agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw new Error(
          `Unable to fetch ${source.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await delay(retryDelayMs(attempt));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw new Error(
          `MediaWiki returned HTTP ${response.status} for ${source.url} after ${attempt} attempts`,
        );
      }
      await delay(retryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    if (!response.ok) {
      throw new Error(`MediaWiki returned HTTP ${response.status} for ${source.url}`);
    }

    const payload = (await response.json()) as MediaWikiParseResponse;
    return validateMediaWikiResponse(payload, source);
  }

  throw new Error(`Unable to fetch ${source.url}`);
}

function validateMediaWikiResponse(
  payload: MediaWikiParseResponse,
  source: MediaWikiSource,
): FetchedPage {
  if (payload.error) {
    throw new Error(
      `MediaWiki error for ${source.url}: ${String(payload.error.code)} ${String(payload.error.info)}`,
    );
  }

  const parsed = payload.parse;
  if (
    !parsed ||
    typeof parsed.title !== 'string' ||
    !Number.isInteger(parsed.pageid) ||
    !Number.isInteger(parsed.revid) ||
    typeof parsed.text !== 'string' ||
    !parsed.text.trim()
  ) {
    throw new Error(`MediaWiki returned an invalid parse response for ${source.url}`);
  }

  return {
    title: parsed.title,
    pageId: parsed.pageid as number,
    revisionId: parsed.revid as number,
    html: parsed.text,
  };
}

function validateDataset(
  parents: readonly IngestedParentRecord[],
  children: readonly ChildChunk[],
): void {
  const expectedParents = Object.values(EXPECTED_SECTIONS_BY_BOOK).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (parents.length !== expectedParents) {
    throw new Error(`Generated ${parents.length} parents; expected ${expectedParents}`);
  }
  if (children.length < parents.length) {
    throw new Error('Every parent must produce at least one child');
  }

  const parentIds = new Set(parents.map((parent) => parent.id));
  const childIds = new Set(children.map((child) => child.id));
  if (parentIds.size !== parents.length || childIds.size !== children.length) {
    throw new Error('Generated parent or child IDs are not unique');
  }
  if (children.some((child) => !parentIds.has(child.parent_id))) {
    throw new Error('Generated child references an unknown parent');
  }
}

function parseArguments(args: readonly string[]): CliOptions {
  let sourcesPath = DEFAULT_SOURCES;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--sources' || argument === '--out-dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === '--sources') {
        sourcesPath = value;
      } else {
        outputDirectory = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { sourcesPath, outputDirectory };
}

function printHelp(): void {
  console.log(`Usage: npm run ingest:meditations -- [options]

Options:
  --sources <path>  URL manifest (default: ${DEFAULT_SOURCES})
  --out-dir <path>  Generated output directory (default: ${DEFAULT_OUTPUT_DIRECTORY})
  -h, --help        Show this help`);
}

function retryDelayMs(attempt: number, retryAfter: string | null = null): number {
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, 30_000);
  }
  return 500 * 2 ** (attempt - 1);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function toJsonLines(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, filePath);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
