import { IngestionError, MediaWikiSource } from './types';

export const MEDITATIONS_BOOKS: readonly number[] = Object.freeze(
  Array.from({ length: 12 }, (_, index) => index + 1),
);

const ROMAN_BOOKS = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
] as const;

export function parseSourceManifest(
  contents: string,
  expectedBooks: readonly number[] = MEDITATIONS_BOOKS,
): readonly MediaWikiSource[] {
  const lines = contents
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new IngestionError(
      'INVALID_SOURCE_MANIFEST',
      undefined,
      'source manifest contains no URLs',
    );
  }

  const sources = lines.map(parseSourceUrl);
  const urls = new Set(sources.map((source) => source.url));
  if (urls.size !== sources.length) {
    throw new IngestionError(
      'INVALID_SOURCE_MANIFEST',
      undefined,
      'source manifest contains a duplicate URL',
    );
  }

  const books = new Set(sources.map((source) => source.book));
  if (books.size !== sources.length) {
    throw new IngestionError(
      'INVALID_SOURCE_MANIFEST',
      undefined,
      'source manifest contains more than one URL for the same book',
    );
  }

  const expected = [...expectedBooks].sort((left, right) => left - right);
  const actual = [...books].sort((left, right) => left - right);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new IngestionError(
      'INVALID_SOURCE_MANIFEST',
      undefined,
      `expected books ${expected.join(', ')}, received ${actual.join(', ')}`,
    );
  }

  return sources.sort((left, right) => left.book - right.book);
}

export function parseSourceUrl(value: string): MediaWikiSource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionError('INVALID_SOURCE_URL', value, 'source is not a valid URL');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'en.wikisource.org') {
    throw new IngestionError(
      'INVALID_SOURCE_URL',
      value,
      'source must use HTTPS on en.wikisource.org',
    );
  }

  const decodedPath = decodeURIComponent(url.pathname).replace(/\/$/u, '');
  if (!decodedPath.startsWith('/wiki/')) {
    throw new IngestionError('INVALID_SOURCE_URL', value, 'source path must begin with /wiki/');
  }

  const pagePath = decodedPath.slice('/wiki/'.length);
  const bookMatch = pagePath.match(/\/Book_([IVX]+)$/u);
  const book = bookMatch
    ? ROMAN_BOOKS.indexOf(bookMatch[1] as (typeof ROMAN_BOOKS)[number]) + 1
    : 0;
  if (book <= 0) {
    throw new IngestionError(
      'INVALID_SOURCE_URL',
      value,
      'source must end in /Book_I through /Book_XII',
    );
  }

  url.search = '';
  url.hash = '';
  url.pathname = decodedPath;

  return {
    book,
    url: url.toString(),
    pageTitle: pagePath.replaceAll('_', ' '),
    apiUrl: `${url.origin}/w/api.php`,
  };
}

export function romanBookNumber(book: number): string {
  const numeral = ROMAN_BOOKS[book - 1];
  if (!numeral) {
    throw new IngestionError(
      'INVALID_SOURCE_MANIFEST',
      undefined,
      `book number ${book} is outside I-XII`,
    );
  }
  return numeral;
}
