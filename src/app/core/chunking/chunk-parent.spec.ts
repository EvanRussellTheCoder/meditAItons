import { CHUNKING_CONFIG, CHUNKING_VERSION } from './config';
import { chunkParent, chunkParents } from './chunk-parent';
import { UnicodeWordTokenCounter } from './tokenizer';
import { ChunkingError, ChunkingResult, ParentRecord, TokenCounter } from './types';

const tokenizer = new UnicodeWordTokenCounter();

describe('Meditations parent/child chunking', () => {
  it('creates exactly one complete child for a short parent', () => {
    const text = 'From my grandfather Verus I learned good morals and the government of my temper.';
    const parent = makeParent(text);

    const result = chunkParent(parent);

    expect(result.chunkingVersion).toBe(CHUNKING_VERSION);
    expect(result.children).toEqual([
      {
        id: `${parent.id}-c01`,
        type: 'child',
        parent_id: parent.id,
        canonical_ref: parent.canonical_ref,
        child_index: 1,
        start_char: 0,
        end_char: text.length,
        token_count: tokenizer.count(text),
        text_search: text,
      },
    ]);
    expect(result.diagnostics).toBeUndefined();
  });

  it('splits a medium parent into ordered sentence-aware children', () => {
    const text = makeSentences('medium', 12, 24);
    const parent = makeParent(text);

    const result = chunkParent(parent, { debug: true });

    expect(result.parentTokenCount).toBeGreaterThan(250);
    expect(result.parentTokenCount).toBeLessThan(350);
    expect(result.children.length).toBeGreaterThan(1);
    expect(result.diagnostics?.parentSizeClass).toBe('medium');
    expect(
      result.diagnostics?.boundaries.slice(0, -1).every((item) => item.boundaryKind === 'sentence'),
    ).toBe(true);
    assertCoreInvariants(parent, result);
  });

  it('prefers paragraph boundaries for a long parent and respects the hard maximum', () => {
    const paragraphs = Array.from({ length: 5 }, (_, index) =>
      makeSentences(`paragraph${index}`, 2, 45),
    );
    const parent = makeParent(paragraphs.join('\n\n'));

    const result = chunkParent(parent, { debug: true });

    expect(result.parentTokenCount).toBeGreaterThan(400);
    expect(result.children.length).toBeGreaterThan(1);
    expect(result.diagnostics?.parentSizeClass).toBe('long');
    expect(result.diagnostics?.boundaries.some((item) => item.boundaryKind === 'paragraph')).toBe(
      true,
    );
    assertCoreInvariants(parent, result);
  });

  it('uses semicolon boundaries before token fallback for an oversized sentence', () => {
    const clauses = Array.from({ length: 3 }, (_, index) => words(`clause${index}`, 120));
    const parent = makeParent(`${clauses.join('; ')}.`);

    const result = chunkParent(parent, { debug: true });

    expect(result.parentTokenCount).toBeGreaterThan(CHUNKING_CONFIG.hardMaxTokens);
    expect(result.diagnostics?.fallbackSplits.semicolon).toBeGreaterThan(0);
    expect(result.diagnostics?.fallbackSplits.token).toBe(0);
    assertCoreInvariants(parent, result);
  });

  it('terminates with token-level spans when no semantic boundary can satisfy the cap', () => {
    const parent = makeParent(words('unbrokenSentence', 620));

    const result = chunkParent(parent, { debug: true });

    expect(result.diagnostics?.fallbackSplits.token).toBeGreaterThan(0);
    expect(result.children.length).toBeGreaterThan(1);
    assertCoreInvariants(parent, result);
  });

  it('overlaps the previous complete sentence without duplicating most of the next child', () => {
    const sentences = Array.from({ length: 6 }, (_, index) => sentence(`overlap${index}`, 39));
    const parent = makeParent(sentences.join(' '));

    const result = chunkParent(parent, { debug: true });

    expect(result.children).toHaveLength(2);
    const first = result.children[0];
    const second = result.children[1];
    const expectedOverlap = `${sentences[3]} `;
    expect(first.text_search.endsWith(expectedOverlap)).toBe(true);
    expect(second.text_search.startsWith(expectedOverlap)).toBe(true);
    expect(second.start_char).toBeLessThan(first.end_char);
    expect(result.diagnostics?.boundaries[1].overlapKind).toBe('sentence');
    assertCoreInvariants(parent, result);
  });

  it('uses a trailing clause when the previous sentence is too large to overlap', () => {
    const longSentence = `${words('mainClause', 99)}; ${words('trailingClause', 29)}.`;
    const nextSentence = sentence('nextCore', 129);
    const parent = makeParent(`${longSentence} ${nextSentence}`);

    const result = chunkParent(parent, { debug: true });

    expect(result.children).toHaveLength(2);
    expect(result.diagnostics?.boundaries[1].overlapKind).toBe('clause');
    expect(result.children[1].text_search.startsWith(`${words('trailingClause', 29)}. `)).toBe(
      true,
    );
    assertCoreInvariants(parent, result);
  });

  it('absorbs a tiny final sentence when it fits semantically under the hard maximum', () => {
    const parent = makeParent(
      [sentence('largeA', 169), sentence('largeB', 169), sentence('tinyTail', 19)].join(' '),
    );

    const result = chunkParent(parent, {
      config: { overlapStrategy: 'none' },
      debug: true,
    });

    expect(result.children).toHaveLength(2);
    expect(result.children[1].text_search).toContain('TinyTail0');
    expect(result.children[1].token_count).toBeGreaterThanOrEqual(
      CHUNKING_CONFIG.minimumDesirableChildTokens,
    );
    assertCoreInvariants(parent, result);
  });

  it('is deterministic for identical parent, config, tokenizer, and algorithm version', () => {
    const parent = makeParent(makeSentences('deterministic', 15, 30));
    const options = {
      config: { maxOverlapTokens: 50 },
      tokenizer,
      debug: true,
    } as const;

    expect(chunkParent(parent, options)).toEqual(chunkParent(parent, options));
  });

  it('preserves Unicode punctuation and exact UTF-16 source offsets', () => {
    const unit =
      '“Attend,” said Marcus—without haste (or complaint); then ask: what is mine to do? It’s enough.';
    const parent = makeParent(Array.from({ length: 20 }, () => unit).join(' '));

    const result = chunkParent(parent);

    expect(result.children.length).toBeGreaterThan(1);
    for (const child of result.children) {
      expect(parent.text_search.slice(child.start_char, child.end_char)).toBe(child.text_search);
    }
    assertCoreInvariants(parent, result);
  });

  it('fails explicitly for empty parent text and includes the parent ID', () => {
    const parent = makeParent('') as ParentRecord;

    expect(() => chunkParent(parent)).toThrowError(ChunkingError);
    expect(() => chunkParent(parent)).toThrowError(
      new RegExp(`parent=${parent.id} reason=text_search must not be empty`),
    );
  });

  it('keeps consecutive batch parents completely isolated', () => {
    const first = makeParent(makeSentences('ONLY_FIRST', 12, 24), 'parent-first', '1.1', 1);
    const second = makeParent(makeSentences('ONLY_SECOND', 12, 24), 'parent-second', '1.2', 2);

    const results = chunkParents([first, second]);

    expect(results).toHaveLength(2);
    expect(results[0].children.every((child) => !child.text_search.includes('ONLY_SECOND'))).toBe(
      true,
    );
    expect(results[1].children.every((child) => !child.text_search.includes('ONLY_FIRST'))).toBe(
      true,
    );
    assertCoreInvariants(first, results[0]);
    assertCoreInvariants(second, results[1]);
  });

  it('does not mutate canonical parent fields', () => {
    const edition = Object.freeze({
      translator: 'George Long',
      year: 1862,
      edition_id: 'long-1862',
    });
    const parent = Object.freeze({
      ...makeParent(makeSentences('immutable', 10, 24)),
      edition,
    });
    const before = structuredClone(parent);

    chunkParent(parent);

    expect(parent).toEqual(before);
  });

  it('wraps tokenizer failures in a structured parent-aware error', () => {
    const failingTokenizer: TokenCounter = {
      count: () => {
        throw new Error('provider unavailable');
      },
    };
    const parent = makeParent('A valid source sentence.');

    expect(() => chunkParent(parent, { tokenizer: failingTokenizer })).toThrowError(
      /parent=meditations-long-1862-b01-s001 reason=token counter threw an error/,
    );
  });

  it('holds identity, ordering, size, offset, and coverage invariants across varied inputs', () => {
    const parents = [
      makeParent(sentence('propertyShort', 20)),
      makeParent(makeSentences('propertyMedium', 10, 24)),
      makeParent(makeSentences('propertyLong', 20, 24)),
      makeParent(words('propertyFallback', 800)),
      makeParent(
        [
          makeSentences('propertyParagraphA', 5, 30),
          makeSentences('propertyParagraphB', 8, 30),
        ].join('\n\n'),
      ),
    ];

    for (const parent of parents) {
      assertCoreInvariants(parent, chunkParent(parent));
    }
  });
});

function makeParent(
  text: string,
  id = 'meditations-long-1862-b01-s001',
  canonicalRef = '1.1',
  section = 1,
): ParentRecord {
  return {
    id,
    type: 'parent',
    work: 'Meditations',
    canonical_ref: canonicalRef,
    edition: {
      translator: 'George Long',
      year: 1862,
      edition_id: 'long-1862',
    },
    book: 1,
    section,
    text_display: text,
    text_search: text,
    content_hash: 'sha256:test-fixture',
  };
}

function makeSentences(prefix: string, count: number, wordsPerSentence: number): string {
  return Array.from({ length: count }, (_, index) =>
    sentence(`${prefix}${index}`, wordsPerSentence),
  ).join(' ');
}

function sentence(prefix: string, wordCount: number): string {
  const sentencePrefix = `${prefix[0]?.toUpperCase() ?? ''}${prefix.slice(1)}`;
  return `${words(sentencePrefix, wordCount)}.`;
}

function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
}

function assertCoreInvariants(parent: ParentRecord, result: ChunkingResult): void {
  expect(result.children.length).toBeGreaterThanOrEqual(1);
  expect(result.parentId).toBe(parent.id);
  expect(result.parentTokenCount).toBe(tokenizer.count(parent.text_search));

  const ids = new Set<string>();
  let coveredEnd = 0;
  let reconstructed = '';

  for (const [zeroBasedIndex, child] of result.children.entries()) {
    const expectedIndex = zeroBasedIndex + 1;
    expect(child.parent_id).toBe(parent.id);
    expect(child.canonical_ref).toBe(parent.canonical_ref);
    expect(child.child_index).toBe(expectedIndex);
    expect(child.id).toBe(`${parent.id}-c${String(expectedIndex).padStart(2, '0')}`);
    expect(ids.has(child.id)).toBe(false);
    ids.add(child.id);

    expect(child.start_char).toBeGreaterThanOrEqual(0);
    expect(child.start_char).toBeLessThan(child.end_char);
    expect(child.end_char).toBeLessThanOrEqual(parent.text_search.length);
    expect(child.start_char).toBeLessThanOrEqual(coveredEnd);
    expect(child.end_char).toBeGreaterThan(coveredEnd);
    expect(child.text_search).toBe(parent.text_search.slice(child.start_char, child.end_char));
    expect(child.token_count).toBe(tokenizer.count(child.text_search));
    expect(child.token_count).toBeLessThanOrEqual(CHUNKING_CONFIG.hardMaxTokens);

    reconstructed += parent.text_search.slice(coveredEnd, child.end_char);
    coveredEnd = child.end_char;
  }

  expect(result.children[0].start_char).toBe(0);
  expect(coveredEnd).toBe(parent.text_search.length);
  expect(reconstructed).toBe(parent.text_search);
}
