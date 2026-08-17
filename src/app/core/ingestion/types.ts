import { ParentRecord } from '../chunking';

export interface MediaWikiSource {
  readonly book: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly apiUrl: string;
}

export interface MediaWikiPageMetadata {
  readonly source: MediaWikiSource;
  readonly pageId: number;
  readonly revisionId: number;
  readonly resolvedTitle: string;
}

export interface ParsedMeditationsSection {
  readonly book: number;
  readonly section: number;
  readonly canonicalRef: string;
  readonly textDisplay: string;
  readonly textSearch: string;
}

export interface ParsedMeditationsBook {
  readonly metadata: MediaWikiPageMetadata;
  readonly sections: readonly ParsedMeditationsSection[];
}

export interface ParentSourceProvenance {
  readonly url: string;
  readonly page_title: string;
  readonly page_id: number;
  readonly revision_id: number;
}

export interface IngestedParentRecord extends ParentRecord {
  readonly source: ParentSourceProvenance;
}

export type ContentHasher = (text: string) => string;

export type IngestionErrorCode =
  | 'INVALID_SOURCE_MANIFEST'
  | 'INVALID_SOURCE_URL'
  | 'INVALID_MEDIAWIKI_RESPONSE'
  | 'INVALID_BOOK_STRUCTURE'
  | 'INVALID_SECTION_SEQUENCE'
  | 'UNEXPECTED_SECTION_COUNT';

export class IngestionError extends Error {
  constructor(
    readonly code: IngestionErrorCode,
    readonly source: string | undefined,
    reason: string,
  ) {
    super(`IngestionError: source=${source ?? 'unknown'} reason=${reason}`);
    this.name = 'IngestionError';
  }
}
