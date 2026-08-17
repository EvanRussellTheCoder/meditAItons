import {
  EXPECTED_SECTIONS_BY_BOOK,
  buildParentRecords,
  parseMeditationsBookDocument,
} from './parse-book';
import { parseSourceManifest, parseSourceUrl } from './source-manifest';
import { IngestionError, MediaWikiPageMetadata } from './types';

describe('Meditations MediaWiki ingestion', () => {
  it('parses, validates, sorts, and normalizes the URL source manifest', () => {
    const manifest = `
      # Deliberately out of order
      https://en.wikisource.org/wiki/Work/Book_II
      https://en.wikisource.org/wiki/Work/Book_I
    `;

    const sources = parseSourceManifest(manifest, [1, 2]);

    expect(sources.map((source) => source.book)).toEqual([1, 2]);
    expect(sources[0]).toEqual({
      book: 1,
      url: 'https://en.wikisource.org/wiki/Work/Book_I',
      pageTitle: 'Work/Book I',
      apiUrl: 'https://en.wikisource.org/w/api.php',
    });
  });

  it('rejects non-Wikisource URLs and incomplete book manifests', () => {
    expect(() => parseSourceUrl('https://example.com/wiki/Work/Book_I')).toThrowError(
      IngestionError,
    );
    expect(() =>
      parseSourceManifest('https://en.wikisource.org/wiki/Work/Book_I', [1, 2]),
    ).toThrowError(/expected books 1, 2, received 1/);
  });

  it('extracts numbered sections, continuation paragraphs, quotes, and no footnotes', () => {
    const document = parseHtml(makeBookHtml(3, 16, { continuationAfterSection: 2 }));

    const parsed = parseMeditationsBookDocument(document, metadata(3));

    expect(parsed.sections).toHaveLength(16);
    expect(parsed.sections[0]).toEqual({
      book: 3,
      section: 1,
      canonicalRef: '3.1',
      textDisplay: 'From the first source.',
      textSearch: 'From the first source.',
    });
    expect(parsed.sections[1].textSearch).toBe(
      'Section 2 canonical text.\n\n“Centered quotation for section 2.”\n\nContinuation paragraph for section 2.',
    );
    expect(parsed.sections.some((section) => section.textSearch.includes('Footnote'))).toBe(false);
  });

  it('recognizes Book XI sections rendered as block elements', () => {
    const document = parseHtml(makeBookHtml(11, 39, { blockSections: [30, 31, 32] }));

    const parsed = parseMeditationsBookDocument(document, metadata(11));

    expect(parsed.sections).toHaveLength(39);
    expect(parsed.sections[29].canonicalRef).toBe('11.30');
    expect(parsed.sections[29].textSearch).toBe('Section 30 canonical text.');
    expect(parsed.sections[31].canonicalRef).toBe('11.32');
  });

  it('fails explicitly for a numbering gap or an unknown meaningful content block', () => {
    const numberingGap = makeBookHtml(3, 16).replace(
      '<p>3. Section 3 canonical text.</p>',
      '<p>4. Section 4 canonical text.</p>',
    );
    expect(() => parseMeditationsBookDocument(parseHtml(numberingGap), metadata(3))).toThrowError(
      /encountered section 4 after 2/,
    );

    const unknownBlock = makeBookHtml(3, 16).replace(
      '<p>2. Section 2 canonical text.</p>',
      '<p>2. Section 2 canonical text.</p><table><tbody><tr><td>Unknown prose</td></tr></tbody></table>',
    );
    expect(() => parseMeditationsBookDocument(parseHtml(unknownBlock), metadata(3))).toThrowError(
      /unexpected table block inside canonical text/,
    );
  });

  it('builds deterministic edition-specific parents with revision provenance', () => {
    const parsed = parseMeditationsBookDocument(parseHtml(makeBookHtml(3, 16)), metadata(3));
    const hash = `sha256:${'a'.repeat(64)}`;

    const parents = buildParentRecords(parsed, () => hash);

    expect(parents[0]).toMatchObject({
      id: 'meditations-long-1862-b03-s001',
      type: 'parent',
      work: 'Meditations',
      canonical_ref: '3.1',
      book: 3,
      section: 1,
      content_hash: hash,
      source: {
        url: metadata(3).source.url,
        page_title: metadata(3).resolvedTitle,
        page_id: 1003,
        revision_id: 2003,
      },
    });
    expect(parents.at(-1)?.id).toBe('meditations-long-1862-b03-s016');
  });

  it('locks the known George Long source to 487 canonical sections', () => {
    expect(Object.values(EXPECTED_SECTIONS_BY_BOOK).reduce((sum, count) => sum + count, 0)).toBe(
      487,
    );
  });
});

function makeBookHtml(
  book: number,
  sectionCount: number,
  options: {
    readonly continuationAfterSection?: number;
    readonly blockSections?: readonly number[];
  } = {},
): string {
  const blocks = [
    '<div class="ws-header ws-noexport">Navigation and source metadata</div>',
    '<div class="wst-center">Decorative book title</div>',
    '<p><style>.dropinitial{float:left}</style><span class="dropinitial"><span>F</span></span>ROM the first source<sup class="reference">[1]</sup>†.</p>',
  ];

  for (let section = 2; section <= sectionCount; section += 1) {
    const text = `${section}. Section ${section} canonical text.`;
    if (options.blockSections?.includes(section)) {
      blocks.push(`<div class="wst-block-left">${text}</div>`);
    } else {
      blocks.push(`<p>${text}</p>`);
    }

    if (options.continuationAfterSection === section) {
      blocks.push('<style>.wst-block-center{display:block}</style>');
      blocks.push('<div class="wst-block-center">“Centered quotation for section 2.”</div>');
      blocks.push('<p>Continuation paragraph for section 2.</p>');
    }
  }

  blocks.push(
    '<div class="mw-heading mw-heading2"><h2 id="Footnotes">Footnotes</h2></div>',
    '<div class="reflist"><p>Footnote text must never enter a parent.</p></div>',
  );

  return `<div class="mw-parser-output" data-book="${book}">${blocks.join('')}</div>`;
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function metadata(book: number): MediaWikiPageMetadata {
  return {
    source: {
      book,
      url: `https://en.wikisource.org/wiki/Work/Book_${book}`,
      pageTitle: `Work/Book ${book}`,
      apiUrl: 'https://en.wikisource.org/w/api.php',
    },
    pageId: 1000 + book,
    revisionId: 2000 + book,
    resolvedTitle: `Work/Book ${book}`,
  };
}
