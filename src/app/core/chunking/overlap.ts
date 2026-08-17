import { AppliedOverlapKind, ChunkingConfig } from './types';
import {
  AtomicUnit,
  CoreChunk,
  CountTokens,
  segmentSentences,
  splitSpanOnDelimiter,
} from './segmentation';

export interface AppliedOverlap {
  readonly start: number;
  readonly kind: AppliedOverlapKind;
}

export function selectOverlap(
  text: string,
  previousCore: CoreChunk,
  nextCore: CoreChunk,
  config: Readonly<ChunkingConfig>,
  countTokens: CountTokens,
  parentId: string,
): AppliedOverlap {
  if (
    config.overlapStrategy === 'none' ||
    config.maxOverlapTokens === 0 ||
    config.maxOverlapRatio === 0
  ) {
    return { start: nextCore.start, kind: 'none' };
  }

  const sentences = segmentSentences(text, previousCore, config.sentenceLocale, parentId);
  const previousSentence = sentences[sentences.length - 1];

  if (
    overlapFits(text, previousSentence.start, previousCore.end, nextCore.end, config, countTokens)
  ) {
    return { start: previousSentence.start, kind: 'sentence' };
  }

  let clauses: readonly AtomicUnit[] = [
    {
      ...previousSentence,
      endBoundary: previousCore.boundaryKind,
    },
  ];

  const delimiters = [
    { delimiter: ';' as const, kind: 'semicolon' as const },
    { delimiter: ':' as const, kind: 'colon' as const },
    { delimiter: '—' as const, kind: 'em_dash' as const },
  ];

  for (const { delimiter, kind } of delimiters) {
    clauses = clauses.flatMap((clause) => splitSpanOnDelimiter(text, clause, delimiter, kind));
    const trailingClause = clauses[clauses.length - 1];
    if (
      trailingClause.start > previousSentence.start &&
      overlapFits(text, trailingClause.start, previousCore.end, nextCore.end, config, countTokens)
    ) {
      return { start: trailingClause.start, kind: 'clause' };
    }
  }

  return { start: nextCore.start, kind: 'none' };
}

function overlapFits(
  text: string,
  candidateStart: number,
  overlapEnd: number,
  childEnd: number,
  config: Readonly<ChunkingConfig>,
  countTokens: CountTokens,
): boolean {
  if (candidateStart < 0 || candidateStart >= overlapEnd || overlapEnd >= childEnd) {
    return false;
  }

  const overlapTokens = countTokens(text.slice(candidateStart, overlapEnd));
  const childTokens = countTokens(text.slice(candidateStart, childEnd));
  if (overlapTokens === 0 || childTokens === 0) {
    return false;
  }

  return (
    overlapTokens <= config.maxOverlapTokens &&
    childTokens <= config.hardMaxTokens &&
    overlapTokens / childTokens <= config.maxOverlapRatio
  );
}
