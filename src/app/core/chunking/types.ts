export interface EditionMetadata {
  readonly translator: string;
  readonly year: number;
  readonly edition_id: string;
}

/** A complete, already-parsed canonical Meditations section. */
export interface ParentRecord {
  readonly id: string;
  readonly type: 'parent';
  readonly work: string;
  readonly canonical_ref: string;
  readonly edition: EditionMetadata;
  readonly book: number;
  readonly section: number;
  readonly text_display: string;
  readonly text_search: string;
  readonly content_hash: string;
}

/** A retrieval-oriented source span derived from exactly one parent. */
export interface ChildChunk {
  readonly id: string;
  readonly type: 'child';
  readonly parent_id: string;
  readonly canonical_ref: string;
  readonly child_index: number;
  /** Inclusive UTF-16 offset into parent.text_search. */
  readonly start_char: number;
  /** Exclusive UTF-16 offset into parent.text_search. */
  readonly end_char: number;
  readonly token_count: number;
  readonly text_search: string;
}

export interface TokenCounter {
  /**
   * Return a deterministic, finite, non-negative integer for the supplied text.
   * Counters used for fallback splitting must be monotonic for growing prefixes.
   */
  count(text: string): number;
}

export type ParentSizeClass = 'short' | 'medium' | 'long';

export type OverlapStrategy = 'none' | 'previous_sentence';

export type SplitBoundaryKind =
  'paragraph' | 'sentence' | 'semicolon' | 'colon' | 'em_dash' | 'token' | 'parent_end';

export type AppliedOverlapKind = 'none' | 'sentence' | 'clause';

export interface ChunkingConfig {
  readonly shortParentMaxTokens: number;
  readonly mediumParentMaxTokens: number;
  readonly mediumTargetMinTokens: number;
  readonly mediumTargetMaxTokens: number;
  readonly longTargetMinTokens: number;
  readonly longTargetMaxTokens: number;
  readonly hardMaxTokens: number;
  readonly minimumDesirableChildTokens: number;
  readonly overlapStrategy: OverlapStrategy;
  readonly maxOverlapTokens: number;
  readonly maxOverlapRatio: number;
  readonly sentenceLocale: string;
}

export interface ChunkBoundaryDiagnostic {
  readonly childIndex: number;
  readonly coreStartChar: number;
  readonly startChar: number;
  readonly endChar: number;
  readonly boundaryKind: SplitBoundaryKind;
  readonly overlapKind: AppliedOverlapKind;
}

export interface ChunkingDiagnostics {
  readonly parentId: string;
  readonly parentTokenCount: number;
  readonly parentSizeClass: ParentSizeClass;
  readonly numberOfChildren: number;
  readonly childTokenCounts: readonly number[];
  readonly boundaries: readonly ChunkBoundaryDiagnostic[];
  readonly fallbackSplits: Readonly<{
    semicolon: number;
    colon: number;
    emDash: number;
    token: number;
  }>;
}

export interface ChunkingResult {
  readonly parentId: string;
  readonly chunkingVersion: string;
  readonly parentTokenCount: number;
  readonly children: readonly ChildChunk[];
  readonly diagnostics?: ChunkingDiagnostics;
}

export interface ChunkingOptions {
  readonly config?: Partial<ChunkingConfig>;
  readonly tokenizer?: TokenCounter;
  readonly debug?: boolean;
}

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export type ChunkingErrorCode =
  | 'INVALID_PARENT'
  | 'EMPTY_PARENT'
  | 'INVALID_CONFIG'
  | 'TOKENIZER_FAILURE'
  | 'SEGMENTATION_FAILURE'
  | 'HARD_MAX_EXCEEDED'
  | 'INVALID_OFFSETS'
  | 'VALIDATION_FAILURE';

export class ChunkingError extends Error {
  constructor(
    readonly code: ChunkingErrorCode,
    readonly parentId: string | undefined,
    reason: string,
  ) {
    super(
      `ChunkingError: parent=${parentId && parentId.trim() ? parentId : 'unknown'} reason=${reason}`,
    );
    this.name = 'ChunkingError';
  }
}
