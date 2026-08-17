import { CHUNKING_VERSION, resolveChunkingConfig } from './config';
import { selectOverlap } from './overlap';
import {
  CountTokens,
  createFallbackSplitCounts,
  packAtomicUnits,
  segmentForLongParent,
  segmentForMediumParent,
} from './segmentation';
import { DEFAULT_TOKEN_COUNTER } from './tokenizer';
import {
  ChildChunk,
  ChunkBoundaryDiagnostic,
  ChunkingError,
  ChunkingOptions,
  ChunkingResult,
  ParentRecord,
  ParentSizeClass,
  TokenCounter,
} from './types';
import { validateChunkingResult, validateParent } from './validation';

/**
 * Deterministically derives retrieval children from one immutable canonical parent.
 * The function never writes to or normalizes the supplied parent record.
 *
 * Plain-English pseudocode:
 * 1. Count the parent's tokens and classify it as short, medium, or long.
 * 2. Keep short verses whole; split longer verses at paragraph and sentence boundaries.
 * 3. Pack those pieces near the configured target size without crossing the hard maximum.
 * 4. When safe, repeat one prior sentence so a new child retains local context.
 * 5. Slice every child from the original text, record its offsets, and validate the result.
 */
export function chunkParent(parent: ParentRecord, options: ChunkingOptions = {}): ChunkingResult {
  validateParent(parent);
  const config = resolveChunkingConfig(options.config, parent.id);
  const countTokens = createSafeCounter(options.tokenizer ?? DEFAULT_TOKEN_COUNTER, parent.id);
  const parentTokenCount = countTokens(parent.text_search);
  const parentSizeClass = classifyParent(parentTokenCount, config);

  if (parentSizeClass === 'short') {
    const child = createChild(parent, 1, 0, parent.text_search.length, countTokens);
    const result: ChunkingResult = {
      parentId: parent.id,
      chunkingVersion: CHUNKING_VERSION,
      parentTokenCount,
      children: [child],
      ...(options.debug
        ? {
            diagnostics: {
              parentId: parent.id,
              parentTokenCount,
              parentSizeClass,
              numberOfChildren: 1,
              childTokenCounts: [child.token_count],
              boundaries: [
                {
                  childIndex: 1,
                  coreStartChar: 0,
                  startChar: 0,
                  endChar: parent.text_search.length,
                  boundaryKind: 'parent_end' as const,
                  overlapKind: 'none' as const,
                },
              ],
              fallbackSplits: { semicolon: 0, colon: 0, emDash: 0, token: 0 },
            },
          }
        : {}),
    };
    validateChunkingResult(parent, result, config, countTokens);
    return result;
  }

  const fallbackSplits = createFallbackSplitCounts();
  const isMedium = parentSizeClass === 'medium';
  const targetMinTokens = isMedium ? config.mediumTargetMinTokens : config.longTargetMinTokens;
  const targetMaxTokens = isMedium ? config.mediumTargetMaxTokens : config.longTargetMaxTokens;
  const units = isMedium
    ? segmentForMediumParent(
        parent.text_search,
        config.sentenceLocale,
        config.hardMaxTokens,
        countTokens,
        parent.id,
        fallbackSplits,
      )
    : segmentForLongParent(
        parent.text_search,
        config.sentenceLocale,
        config.hardMaxTokens,
        countTokens,
        parent.id,
        fallbackSplits,
      );

  const coreChunks = packAtomicUnits(
    parent.text_search,
    units,
    targetMinTokens,
    targetMaxTokens,
    config.hardMaxTokens,
    config.minimumDesirableChildTokens,
    countTokens,
    parent.id,
  );

  const children: ChildChunk[] = [];
  const boundaries: ChunkBoundaryDiagnostic[] = [];

  for (const [zeroBasedIndex, core] of coreChunks.entries()) {
    const childIndex = zeroBasedIndex + 1;
    const overlap =
      zeroBasedIndex === 0
        ? { start: core.start, kind: 'none' as const }
        : selectOverlap(
            parent.text_search,
            coreChunks[zeroBasedIndex - 1],
            core,
            config,
            countTokens,
            parent.id,
          );
    const child = createChild(parent, childIndex, overlap.start, core.end, countTokens);
    children.push(child);
    boundaries.push({
      childIndex,
      coreStartChar: core.start,
      startChar: overlap.start,
      endChar: core.end,
      boundaryKind: core.boundaryKind,
      overlapKind: overlap.kind,
    });
  }

  const result: ChunkingResult = {
    parentId: parent.id,
    chunkingVersion: CHUNKING_VERSION,
    parentTokenCount,
    children,
    ...(options.debug
      ? {
          diagnostics: {
            parentId: parent.id,
            parentTokenCount,
            parentSizeClass,
            numberOfChildren: children.length,
            childTokenCounts: children.map((child) => child.token_count),
            boundaries,
            fallbackSplits: {
              semicolon: fallbackSplits.semicolon,
              colon: fallbackSplits.colon,
              emDash: fallbackSplits.emDash,
              token: fallbackSplits.token,
            },
          },
        }
      : {}),
  };

  validateChunkingResult(parent, result, config, countTokens);
  return result;
}

/** Batch convenience API; each parent is deliberately chunked in isolation. */
export function chunkParents(
  parents: readonly ParentRecord[],
  options: ChunkingOptions = {},
): readonly ChunkingResult[] {
  return parents.map((parent) => chunkParent(parent, options));
}

function createChild(
  parent: ParentRecord,
  childIndex: number,
  startChar: number,
  endChar: number,
  countTokens: CountTokens,
): ChildChunk {
  const textSearch = parent.text_search.slice(startChar, endChar);
  return {
    id: `${parent.id}-c${String(childIndex).padStart(2, '0')}`,
    type: 'child',
    parent_id: parent.id,
    canonical_ref: parent.canonical_ref,
    child_index: childIndex,
    start_char: startChar,
    end_char: endChar,
    token_count: countTokens(textSearch),
    text_search: textSearch,
  };
}

function createSafeCounter(tokenizer: TokenCounter, parentId: string): CountTokens {
  return (text: string): number => {
    let count: number;
    try {
      count = tokenizer.count(text);
    } catch {
      throw new ChunkingError('TOKENIZER_FAILURE', parentId, 'token counter threw an error');
    }

    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      throw new ChunkingError(
        'TOKENIZER_FAILURE',
        parentId,
        'token counter must return a finite non-negative integer',
      );
    }
    return count;
  };
}

function classifyParent(
  tokenCount: number,
  config: {
    readonly shortParentMaxTokens: number;
    readonly mediumParentMaxTokens: number;
  },
): ParentSizeClass {
  if (tokenCount <= config.shortParentMaxTokens) {
    return 'short';
  }
  return tokenCount <= config.mediumParentMaxTokens ? 'medium' : 'long';
}
