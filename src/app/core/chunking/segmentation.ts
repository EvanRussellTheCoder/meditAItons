import { ChunkingError, SourceSpan, SplitBoundaryKind } from './types';

export type CountTokens = (text: string) => number;

export interface AtomicUnit extends SourceSpan {
  readonly endBoundary: SplitBoundaryKind;
}

export interface CoreChunk extends SourceSpan {
  readonly units: readonly AtomicUnit[];
  readonly tokenCount: number;
  readonly boundaryKind: SplitBoundaryKind;
}

export interface FallbackSplitCounts {
  semicolon: number;
  colon: number;
  emDash: number;
  token: number;
}

export function createFallbackSplitCounts(): FallbackSplitCounts {
  return { semicolon: 0, colon: 0, emDash: 0, token: 0 };
}

export function segmentForMediumParent(
  text: string,
  locale: string,
  hardMaxTokens: number,
  countTokens: CountTokens,
  parentId: string,
  fallbackCounts: FallbackSplitCounts,
): readonly AtomicUnit[] {
  const parentSpan = { start: 0, end: text.length };
  const sentenceSpans = segmentSentences(text, parentSpan, locale, parentId);

  return sentenceSpans.flatMap((span, index) =>
    splitOversizedUnit(
      text,
      {
        ...span,
        endBoundary: index === sentenceSpans.length - 1 ? 'parent_end' : 'sentence',
      },
      hardMaxTokens,
      countTokens,
      parentId,
      fallbackCounts,
    ),
  );
}

export function segmentForLongParent(
  text: string,
  locale: string,
  hardMaxTokens: number,
  countTokens: CountTokens,
  parentId: string,
  fallbackCounts: FallbackSplitCounts,
): readonly AtomicUnit[] {
  const paragraphs = segmentParagraphs(text);
  const units: AtomicUnit[] = [];

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const paragraphEndBoundary: SplitBoundaryKind =
      paragraphIndex === paragraphs.length - 1 ? 'parent_end' : 'paragraph';

    if (countTokens(text.slice(paragraph.start, paragraph.end)) <= hardMaxTokens) {
      units.push({ ...paragraph, endBoundary: paragraphEndBoundary });
      continue;
    }

    const sentences = segmentSentences(text, paragraph, locale, parentId);
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const endBoundary =
        sentenceIndex === sentences.length - 1 ? paragraphEndBoundary : 'sentence';
      units.push(
        ...splitOversizedUnit(
          text,
          { ...sentence, endBoundary },
          hardMaxTokens,
          countTokens,
          parentId,
          fallbackCounts,
        ),
      );
    }
  }

  return units;
}

/** Paragraph spans partition the input and retain blank-line separators verbatim. */
export function segmentParagraphs(text: string): readonly SourceSpan[] {
  const spans: SourceSpan[] = [];
  const paragraphBoundary = /(?:\r?\n)[\t ]*(?:\r?\n)+(?:[\t ]*\r?\n)*/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = paragraphBoundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end > start) {
      spans.push({ start, end });
    }
    start = end;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length });
  }

  return spans.length > 0 ? spans : [{ start: 0, end: text.length }];
}

/** Uses the platform's Unicode-aware sentence segmenter and keeps its exact offsets. */
export function segmentSentences(
  text: string,
  span: SourceSpan,
  locale: string,
  parentId: string,
): readonly SourceSpan[] {
  if (typeof Intl.Segmenter !== 'function') {
    throw new ChunkingError(
      'SEGMENTATION_FAILURE',
      parentId,
      'Intl.Segmenter is required for reliable sentence detection',
    );
  }

  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    throw new ChunkingError(
      'SEGMENTATION_FAILURE',
      parentId,
      `unable to create a sentence segmenter for locale ${locale}`,
    );
  }

  const source = text.slice(span.start, span.end);
  const spans = Array.from(segmenter.segment(source), (part) => ({
    start: span.start + part.index,
    end: span.start + part.index + part.segment.length,
  })).filter((sentence) => sentence.end > sentence.start);

  if (spans.length === 0) {
    throw new ChunkingError(
      'SEGMENTATION_FAILURE',
      parentId,
      'sentence segmentation yielded no source spans',
    );
  }

  if (spans[0].start !== span.start || spans.at(-1)?.end !== span.end) {
    throw new ChunkingError(
      'INVALID_OFFSETS',
      parentId,
      'sentence segmentation did not preserve the complete source span',
    );
  }

  return spans;
}

export function splitSpanOnDelimiter(
  text: string,
  unit: AtomicUnit,
  delimiter: ';' | ':' | '—',
  boundaryKind: 'semicolon' | 'colon' | 'em_dash',
): readonly AtomicUnit[] {
  const pieces: AtomicUnit[] = [];
  let start = unit.start;
  let cursor = unit.start;

  while (cursor < unit.end) {
    const delimiterAt = text.indexOf(delimiter, cursor);
    if (delimiterAt < 0 || delimiterAt >= unit.end) {
      break;
    }

    let end = delimiterAt + delimiter.length;
    while (end < unit.end && /\s/u.test(text[end])) {
      end += 1;
    }

    if (end > start && end < unit.end) {
      pieces.push({ start, end, endBoundary: boundaryKind });
      start = end;
    }
    cursor = delimiterAt + delimiter.length;
  }

  if (start < unit.end) {
    pieces.push({ start, end: unit.end, endBoundary: unit.endBoundary });
  }

  return pieces.length > 0 ? pieces : [unit];
}

export function packAtomicUnits(
  text: string,
  units: readonly AtomicUnit[],
  targetMinTokens: number,
  targetMaxTokens: number,
  hardMaxTokens: number,
  minimumDesirableChildTokens: number,
  countTokens: CountTokens,
  parentId: string,
): readonly CoreChunk[] {
  if (units.length === 0) {
    throw new ChunkingError(
      'SEGMENTATION_FAILURE',
      parentId,
      'segmentation yielded no atomic units',
    );
  }

  const groups: AtomicUnit[][] = [];
  let current: AtomicUnit[] = [];

  for (const unit of units) {
    const unitTokens = countTokens(text.slice(unit.start, unit.end));
    if (unitTokens > hardMaxTokens) {
      throw new ChunkingError(
        'HARD_MAX_EXCEEDED',
        parentId,
        `atomic source span ${unit.start}-${unit.end} exceeds hardMaxTokens`,
      );
    }

    if (current.length === 0) {
      current = [unit];
      continue;
    }

    const combinedTokens = countTokens(text.slice(current[0].start, unit.end));
    const currentTokens = countTokens(
      text.slice(current[0].start, current[current.length - 1].end),
    );

    if (
      combinedTokens <= targetMaxTokens ||
      (currentTokens < targetMinTokens && combinedTokens <= hardMaxTokens)
    ) {
      current.push(unit);
      continue;
    }

    groups.push(current);
    current = [unit];
  }

  if (current.length > 0) {
    groups.push(current);
  }

  rebalanceTinyTail(text, groups, hardMaxTokens, minimumDesirableChildTokens, countTokens);

  return groups.map((group) => {
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const tokenCount = countTokens(text.slice(start, end));
    if (tokenCount > hardMaxTokens) {
      throw new ChunkingError(
        'HARD_MAX_EXCEEDED',
        parentId,
        `packed source span ${start}-${end} exceeds hardMaxTokens`,
      );
    }
    return {
      start,
      end,
      units: group,
      tokenCount,
      boundaryKind: group[group.length - 1].endBoundary,
    };
  });
}

function splitOversizedUnit(
  text: string,
  unit: AtomicUnit,
  hardMaxTokens: number,
  countTokens: CountTokens,
  parentId: string,
  fallbackCounts: FallbackSplitCounts,
): readonly AtomicUnit[] {
  let units: readonly AtomicUnit[] = [unit];
  const delimiters = [
    { delimiter: ';' as const, kind: 'semicolon' as const, countKey: 'semicolon' as const },
    { delimiter: ':' as const, kind: 'colon' as const, countKey: 'colon' as const },
    { delimiter: '—' as const, kind: 'em_dash' as const, countKey: 'emDash' as const },
  ];

  for (const { delimiter, kind, countKey } of delimiters) {
    units = units.flatMap((candidate) => {
      if (countTokens(text.slice(candidate.start, candidate.end)) <= hardMaxTokens) {
        return [candidate];
      }
      const pieces = splitSpanOnDelimiter(text, candidate, delimiter, kind);
      if (pieces.length > 1) {
        fallbackCounts[countKey] += pieces.length - 1;
      }
      return pieces;
    });
  }

  return units.flatMap((candidate) => {
    if (countTokens(text.slice(candidate.start, candidate.end)) <= hardMaxTokens) {
      return [candidate];
    }
    const pieces = splitAtTokenLimit(text, candidate, hardMaxTokens, countTokens, parentId);
    fallbackCounts.token += pieces.length - 1;
    return pieces;
  });
}

function splitAtTokenLimit(
  text: string,
  unit: AtomicUnit,
  hardMaxTokens: number,
  countTokens: CountTokens,
  parentId: string,
): readonly AtomicUnit[] {
  const codePointEnds: number[] = [];
  for (let cursor = unit.start; cursor < unit.end;) {
    const codePoint = text.codePointAt(cursor);
    cursor += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    codePointEnds.push(cursor);
  }

  const pieces: AtomicUnit[] = [];
  let start = unit.start;
  let positionIndex = 0;

  while (start < unit.end) {
    if (countTokens(text.slice(start, unit.end)) <= hardMaxTokens) {
      pieces.push({ start, end: unit.end, endBoundary: unit.endBoundary });
      break;
    }

    while (positionIndex < codePointEnds.length && codePointEnds[positionIndex] <= start) {
      positionIndex += 1;
    }

    let low = positionIndex;
    let high = codePointEnds.length - 1;
    let bestIndex = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidateEnd = Math.min(codePointEnds[middle], unit.end);
      const candidateTokens = countTokens(text.slice(start, candidateEnd));
      if (candidateTokens <= hardMaxTokens) {
        bestIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (bestIndex < 0 || codePointEnds[bestIndex] <= start) {
      throw new ChunkingError(
        'HARD_MAX_EXCEEDED',
        parentId,
        `unable to satisfy hardMaxTokens within source span ${unit.start}-${unit.end}`,
      );
    }

    const end = Math.min(codePointEnds[bestIndex], unit.end);
    pieces.push({ start, end, endBoundary: 'token' });
    start = end;
    positionIndex = bestIndex + 1;
  }

  return pieces;
}

function rebalanceTinyTail(
  text: string,
  groups: AtomicUnit[][],
  hardMaxTokens: number,
  minimumDesirableChildTokens: number,
  countTokens: CountTokens,
): void {
  if (groups.length < 2) {
    return;
  }

  const tail = groups[groups.length - 1];
  const previous = groups[groups.length - 2];
  const groupTokens = (group: readonly AtomicUnit[]): number =>
    countTokens(text.slice(group[0].start, group[group.length - 1].end));

  if (groupTokens(tail) >= minimumDesirableChildTokens) {
    return;
  }

  const merged = [...previous, ...tail];
  if (groupTokens(merged) <= hardMaxTokens) {
    groups.splice(groups.length - 2, 2, merged);
    return;
  }

  while (groupTokens(tail) < minimumDesirableChildTokens && previous.length > 1) {
    const unitToMove = previous[previous.length - 1];
    const candidatePrevious = previous.slice(0, -1);
    const candidateTail = [unitToMove, ...tail];

    if (
      groupTokens(candidatePrevious) < minimumDesirableChildTokens ||
      groupTokens(candidateTail) > hardMaxTokens
    ) {
      break;
    }

    previous.pop();
    tail.unshift(unitToMove);
  }
}
