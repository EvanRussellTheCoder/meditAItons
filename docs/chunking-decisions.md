# Meditations parent/child chunking: implementation decisions

This log records the implementation choices made for the parent/child chunking layer and
why each choice was made. It is intentionally explicit so a future ingestion service can
adopt the module without reverse-engineering boundary behavior.

## Scope decisions

1. **The implementation is a pure TypeScript library in `src/app/core/chunking`.**
   The repository currently contains one TypeScript/Angular package and no separate server
   package. Keeping the chunker free of Angular APIs makes it usable from a later Node
   ingestion backend while allowing the existing build and Vitest setup to verify it now.

2. **Only canonical parents enter the module and only child records leave it.**
   No scraper, parser, source cleaner, annotation handler, embedding client, vector store,
   retriever, classifier, LLM call, API route, or UI integration was added. Those operations
   have different correctness boundaries and are explicit non-goals.

3. **A batch API is a map over the single-parent API.**
   `chunkParents` calls `chunkParent` independently for every record. It never creates a
   shared segmentation buffer, making cross-parent text leakage impossible by construction.

## Public contract decisions

4. **`chunkParent(parent, options)` is the primary API and returns structured metadata.**
   The result contains `parentId`, `chunkingVersion`, `parentTokenCount`, and `children`.
   Callers do not need to know about paragraph segmentation, packing, or overlap internals.

5. **Parent fields are declared readonly and are never copied back or normalized.**
   The chunker reads `text_search` and identity metadata only. Every child text is an exact
   `text_search.slice(start_char, end_char)`, so canonical text remains the sole source of
   truth and frozen parent objects are accepted.

6. **Offsets are zero-based UTF-16 code-unit offsets, inclusive at the start and exclusive
   at the end.** JavaScript's `String.prototype.slice` uses these semantics, so the invariant
   can be checked directly without an offset conversion layer. This also keeps curly quotes,
   em dashes, and other Unicode text traceable in the runtime that produces the records.

7. **Child IDs use one-based indices padded to at least two digits.**
   The implementation is `${parent.id}-c${index.padStart(2, '0')}`. Indices above 99 remain
   untruncated, maintaining uniqueness and textual order.

8. **Malformed input throws `ChunkingError` with a stable code and parent-aware message.**
   Missing IDs/references, non-positive book or section numbers, non-parent types,
   whitespace-only search text, tokenizer failures, invalid configuration, invalid offsets,
   segmentation failures, and hard-cap failures are explicit. Fields such as translator and
   content hash are typed but not semantically validated because the chunker does not use or
   own them.

## Configuration and version decisions

9. **All policy numbers are centralized in `CHUNKING_CONFIG`.**
   The supplied 180/400 parent thresholds, 120–180 medium target, 150–220 long target, and
   260 hard cap are the defaults. The 60-token minimum desirable child size is a soft tail
   preference. This prevents size-policy magic numbers from being distributed through the
   algorithm.

10. **Overlap has three independent controls.**
    `overlapStrategy`, `maxOverlapTokens` (80), and `maxOverlapRatio` (0.4) can be replaced per
    call. The token cap limits absolute duplication, while the ratio below one-half guarantees
    that overlap cannot constitute most of a child. `none` makes adjacent child ranges touch
    exactly.

11. **The algorithm version is `parent-child-v1`.**
    It is exported rather than embedded only in diagnostics. Any future change to default
    tokenization, sentence segmentation, boundary fallback order, packing, overlap, or other
    behavior capable of moving child boundaries must increment this version. Merely supplying
    a different documented config does not change the algorithm version; config remains a
    separate determinism input.

12. **Configuration is resolved once, validated, and frozen per call.**
    Target minima cannot exceed target maxima, preferred values cannot exceed the hard cap,
    and overlap settings are bounded. Failing early is preferable to producing plausible but
    policy-invalid records.

## Tokenization decisions

13. **Token counting is injected through the minimal `TokenCounter.count(text)` interface.**
    Exactly the same safe wrapper counts parents, packing candidates, overlaps, children, and
    validation values. This avoids coupling chunking to an embedding vendor. A counter used
    for token fallback must be deterministic and monotonic for growing prefixes; this is
    documented on the interface.

14. **The included default is `UnicodeWordTokenCounter`.**
    It counts Unicode word-like runs and individual non-whitespace punctuation marks. It is a
    deterministic provider-neutral counter suitable for local processing and tests, not a
    claim to match a future embedding model. When the embedding model is chosen, ingestion
    should inject that model's token counter and record it alongside the chunking inputs.

15. **Token fallback finds the largest Unicode-safe prefix under the hard cap.**
    A binary search over code-point ends guarantees progress without splitting surrogate
    pairs. Semantic clause splitting has already failed at this point. The counter's monotonic
    prefix contract makes the search deterministic, and failure to fit even one code point is
    reported rather than looped over indefinitely.

## Segmentation decisions

16. **Paragraph separators stay in the source spans.**
    A blank-line run is assigned to the paragraph before it. Paragraph spans therefore
    partition the complete original string with no destructive trimming, and a child that
    spans multiple paragraphs naturally includes the exact original separator.

17. **Sentence detection uses `Intl.Segmenter` with the configurable `en` locale.**
    This Unicode-aware platform implementation handles punctuation, quotations,
    parentheses, and common abbreviation behavior more reliably than splitting on periods.
    An environment without `Intl.Segmenter` fails explicitly; a naive regex fallback would
    silently change boundaries and offset behavior.

18. **Medium parents begin with sentence units; long parents begin with paragraph units.**
    A long-parent paragraph stays atomic while it is at or below the 260-token hard cap, even
    if it is somewhat larger than the preferred target. An oversized paragraph is refined to
    sentences. This makes paragraph semantics stronger than target uniformity while retaining
    an absolute maximum.

19. **Only oversized sentences descend through clause boundaries.**
    The fallback order is semicolon, colon, em dash, then token-level splitting. Em dash is the
    one additional safe clause marker because the source uses it as strong prose punctuation.
    Commas were deliberately excluded: George Long's long philosophical sentences use them
    frequently, and treating each comma as a safe boundary would fragment coherent clauses.

20. **Delimiter punctuation and following whitespace stay with the preceding unit.**
    This avoids children starting with semicolons, colons, or incidental spaces while keeping
    every character represented exactly once before overlap is applied.

## Packing and tail decisions

21. **Atomic units are packed greedily in reading order.**
    The next unit is added while the combined span is within the preferred maximum. If the
    current group is below its target minimum, one coherent unit may take it above the
    preferred maximum but never above the hard maximum. Sentences and paragraphs are not split
    merely to hit an exact target.

22. **Tiny-tail handling is a separate final rebalance, not a general packing exception.**
    If the last group is below 60 tokens, it is first merged into the preceding group when the
    merged source span fits under 260. Otherwise, whole trailing semantic units move from the
    preceding group while both groups remain viable. If neither operation is safe, the small
    tail remains because the minimum is intentionally soft. Separating this pass prevents
    every short sentence from forcing an otherwise complete child to keep growing.

23. **Rebalancing never moves partial sentences or changes source order.**
    It only transfers atomic units created by the structural splitter. This makes its output
    explainable and maintains exact, gap-free core coverage.

## Overlap decisions

24. **Overlap is applied after non-overlapping core chunks have been finalized.**
    The core spans first form an exact partition of the parent. Extending a later child's start
    backward cannot remove or reorder unique content, and coverage can be validated separately
    from intentional duplication.

25. **The default overlap candidate is the final complete sentence of the previous core.**
    It is accepted only if the resulting child stays under 260 tokens, the overlap stays under
    80 tokens, and overlap is at most 40% of that child. The candidate is necessarily inside
    the same parent because the selector receives only adjacent cores from one call.

26. **An oversized previous sentence falls back to its trailing clause, then to no overlap.**
    Clause discovery follows semicolon, colon, and em-dash boundaries. Arbitrary partial-token
    overlap is not added because continuity does not justify starting a child with a severed
    phrase. Skipping overlap is safer than violating the cap or creating a near duplicate.

27. **No child can consist only of overlap.**
    Every child is constructed around a non-empty core whose end extends beyond the previous
    child's end. Validation enforces that each successive child contributes new source text.

## Validation, diagnostics, and test decisions

28. **Every result is validated before it is returned.**
    Validation checks identity, unique deterministic IDs, sequential indices, canonical
    reference, exact source slicing, stored token counts, the hard cap, source ordering,
    overlap policy, and continuous start-to-end parent coverage. It does not rely on tests or
    downstream ingestion to catch corrupt output.

29. **Coverage is validated as an ordered interval invariant.**
    The first child starts at zero, no next child starts after the previous end, every next end
    advances, and the last child ends at the parent length. This proves there are no gaps and
    that all duplication is confined to adjacent overlap ranges.

30. **Diagnostics are opt-in structured data rather than console logging.**
    `debug: true` adds the parent size class, child counts, core and visible offsets, selected
    boundary/overlap types, and semicolon/colon/em-dash/token fallback counts. Production stays
    quiet, while ingestion tests and audits can explain a boundary decision.

31. **Tests use both example cases and a deterministic property matrix.**
    Coverage includes short, medium, long/paragraph, oversized sentence with clause fallback,
    unavoidable token fallback, sentence overlap, clause overlap, tiny-tail handling,
    determinism, Unicode punctuation, empty input, tokenizer errors, immutability, and two-parent
    batch isolation. The property matrix repeats identity, order, cap, exact-offset, and full
    coverage assertions over structurally different inputs.

## Usage

```ts
import { chunkParent } from './core/chunking';

const result = chunkParent(parent, {
  tokenizer: embeddingModelTokenCounter,
  debug: false,
});
```

The caller should persist or otherwise record the chunking version, effective configuration,
and tokenizer identity with generated artifacts. Identical parent text, configuration,
tokenizer, and algorithm version produce identical child order, IDs, offsets, text, and counts.
