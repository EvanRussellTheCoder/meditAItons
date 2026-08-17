import {
  ContentHasher,
  IngestedParentRecord,
  IngestionError,
  MediaWikiPageMetadata,
  ParsedMeditationsBook,
  ParsedMeditationsSection,
} from './types';

export const EXPECTED_SECTIONS_BY_BOOK: Readonly<Record<number, number>> = Object.freeze({
  1: 17,
  2: 17,
  3: 16,
  4: 51,
  5: 36,
  6: 59,
  7: 75,
  8: 61,
  9: 42,
  10: 38,
  11: 39,
  12: 36,
});

const REMOVED_SELECTORS = [
  'style',
  'script',
  'link',
  'sup.reference',
  '.ws-noexport',
  '.noprint',
  '.mw-editsection',
].join(',');

export function parseMeditationsBookDocument(
  document: Document,
  metadata: MediaWikiPageMetadata,
): ParsedMeditationsBook {
  const root = document.querySelector('.mw-parser-output');
  if (!root) {
    throw new IngestionError(
      'INVALID_BOOK_STRUCTURE',
      metadata.source.url,
      'MediaWiki HTML has no .mw-parser-output root',
    );
  }

  const blocks = extractCanonicalBlocks(root, metadata.source.url);
  const sections: Array<{ section: number; paragraphs: string[] }> = [];

  for (const block of blocks) {
    const numbered = block.match(/^(\d+)\.\s*(.*)$/su);
    if (sections.length === 0) {
      const firstNumber = numbered ? Number(numbered[1]) : 1;
      if (firstNumber !== 1) {
        throw sequenceError(metadata, `first canonical section is ${firstNumber}, expected 1`);
      }
      const firstText = numbered ? numbered[2].trim() : block;
      if (!firstText) {
        throw structureError(metadata, 'section 1 has no text');
      }
      sections.push({ section: 1, paragraphs: [firstText] });
      continue;
    }

    if (!numbered) {
      sections[sections.length - 1].paragraphs.push(block);
      continue;
    }

    const sectionNumber = Number(numbered[1]);
    const expectedNumber = sections[sections.length - 1].section + 1;
    if (sectionNumber !== expectedNumber) {
      throw sequenceError(
        metadata,
        `encountered section ${sectionNumber} after ${expectedNumber - 1}`,
      );
    }

    const text = numbered[2].trim();
    if (!text) {
      throw structureError(metadata, `section ${sectionNumber} has no text`);
    }
    sections.push({ section: sectionNumber, paragraphs: [text] });
  }

  const expectedCount = EXPECTED_SECTIONS_BY_BOOK[metadata.source.book];
  if (!expectedCount || sections.length !== expectedCount) {
    throw new IngestionError(
      'UNEXPECTED_SECTION_COUNT',
      metadata.source.url,
      `book ${metadata.source.book} produced ${sections.length} sections; expected ${expectedCount ?? 'a configured count'}`,
    );
  }

  return {
    metadata,
    sections: sections.map(({ section, paragraphs }): ParsedMeditationsSection => {
      const text = paragraphs.join('\n\n');
      return {
        book: metadata.source.book,
        section,
        canonicalRef: `${metadata.source.book}.${section}`,
        textDisplay: text,
        textSearch: text,
      };
    }),
  };
}

export function buildParentRecords(
  parsedBook: ParsedMeditationsBook,
  hashContent: ContentHasher,
): readonly IngestedParentRecord[] {
  return parsedBook.sections.map((section) => {
    const bookId = String(section.book).padStart(2, '0');
    const sectionId = String(section.section).padStart(3, '0');
    const contentHash = hashContent(section.textSearch);
    if (!/^sha256:[a-f0-9]{64}$/u.test(contentHash)) {
      throw new IngestionError(
        'INVALID_BOOK_STRUCTURE',
        parsedBook.metadata.source.url,
        'content hasher must return sha256 followed by 64 lowercase hexadecimal characters',
      );
    }

    return {
      id: `meditations-long-1862-b${bookId}-s${sectionId}`,
      type: 'parent',
      work: 'Meditations',
      canonical_ref: section.canonicalRef,
      edition: {
        translator: 'George Long',
        year: 1862,
        edition_id: 'long-1862',
      },
      book: section.book,
      section: section.section,
      text_display: section.textDisplay,
      text_search: section.textSearch,
      content_hash: contentHash,
      source: {
        url: parsedBook.metadata.source.url,
        page_title: parsedBook.metadata.resolvedTitle,
        page_id: parsedBook.metadata.pageId,
        revision_id: parsedBook.metadata.revisionId,
      },
    };
  });
}

function extractCanonicalBlocks(root: Element, sourceUrl: string): readonly string[] {
  const blocks: string[] = [];
  let canonicalTextStarted = false;

  for (const element of Array.from(root.children)) {
    if (isFootnotesHeading(element)) {
      break;
    }

    if (['STYLE', 'LINK', 'SCRIPT'].includes(element.tagName)) {
      continue;
    }

    const isParagraph = element.tagName === 'P';
    if (!canonicalTextStarted && !isParagraph) {
      continue;
    }
    canonicalTextStarted = true;

    const isKnownQuoteBlock =
      element.tagName === 'DIV' &&
      (element.classList.contains('wst-block-center') ||
        element.classList.contains('wst-block-left'));
    const isSupportedBlock = isParagraph || isKnownQuoteBlock || element.tagName === 'BLOCKQUOTE';
    const text = cleanCanonicalBlock(element);

    if (!text) {
      continue;
    }
    if (!isSupportedBlock) {
      throw new IngestionError(
        'INVALID_BOOK_STRUCTURE',
        sourceUrl,
        `unexpected ${element.tagName.toLowerCase()} block inside canonical text: ${text.slice(0, 80)}`,
      );
    }
    blocks.push(text);
  }

  if (!canonicalTextStarted || blocks.length === 0) {
    throw new IngestionError(
      'INVALID_BOOK_STRUCTURE',
      sourceUrl,
      'no canonical section blocks were found before Footnotes',
    );
  }
  return blocks;
}

function cleanCanonicalBlock(element: Element): string {
  const hasDropInitial = element.querySelector('.dropinitial') !== null;
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(REMOVED_SELECTORS).forEach((node) => node.remove());
  clone.querySelectorAll('br').forEach((lineBreak) => lineBreak.replaceWith('\n'));

  let text = (clone.textContent ?? '')
    .replace(/\u00a0/gu, ' ')
    .replace(/[†‡]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  if (hasDropInitial) {
    text = text.replace(/^([A-Z])([A-Z]+)/u, (_, first: string, rest: string) => {
      return `${first}${rest.toLocaleLowerCase('en')}`;
    });
  }
  return text;
}

function isFootnotesHeading(element: Element): boolean {
  return (
    element.matches('h2#Footnotes') ||
    element.querySelector('h2#Footnotes') !== null ||
    element.querySelector('h2[id^="Footnote"]') !== null
  );
}

function sequenceError(metadata: MediaWikiPageMetadata, reason: string): IngestionError {
  return new IngestionError('INVALID_SECTION_SEQUENCE', metadata.source.url, reason);
}

function structureError(metadata: MediaWikiPageMetadata, reason: string): IngestionError {
  return new IngestionError('INVALID_BOOK_STRUCTURE', metadata.source.url, reason);
}
