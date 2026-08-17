# Meditations MediaWiki ingestion: implementation decisions

This log records the decisions made for the Wikisource-to-parent ingestion layer that runs
before parent/child chunking. Chunk-boundary decisions remain documented separately in
[`chunking-decisions.md`](chunking-decisions.md).

## Source and API decisions

1. **The URL manifest is the source of truth.** The twelve page URLs remain in
   `data/sources/meditations-wiki-urls-georgelang.txt`; source URLs are not embedded in code.
   Blank lines and full-line `#` comments are allowed so the file stays readable.

2. **The manifest must contain exactly one English Wikisource URL for every book I–XII.**
   HTTPS, hostname, `/wiki/` path, Roman book suffix, duplicate URL, duplicate book, and missing
   book checks all run before the first request. The parser was designed and tested against the
   English George Long pages, so accepting another wiki silently would be unsafe.

3. **The CLI uses MediaWiki's `action=parse` endpoint with rendered HTML and revision metadata.**
   MediaWiki performs template expansion and site-specific wikitext rendering. Parsing that
   HTML is substantially less brittle than reimplementing MediaWiki template semantics. The
   request asks only for `text|revid`; navigation and footnotes are removed locally.

4. **Pages are fetched sequentially with a 250 ms courtesy delay.** A previous parallel probe
   reached HTTP 429 on the twelfth page. Sequential fetching is fast enough for twelve books and
   kinder to the public API.

5. **HTTP 429 and server errors receive bounded retries.** The CLI honors a numeric
   `Retry-After` value up to 30 seconds or uses deterministic exponential delays of 500, 1,000,
   and 2,000 ms. Four total attempts prevent an infinite retry loop. Other HTTP errors fail
   immediately because retrying malformed or unauthorized requests would hide the cause.

6. **The API response is validated before HTML parsing.** Title, page ID, revision ID, and
   non-empty HTML are mandatory. MediaWiki error objects and malformed JSON shapes stop the run.

## Canonical parsing decisions

7. **Canonical content starts at the first top-level paragraph after the Wikisource header.**
   This skips the work-navigation header, embedded source metadata, styles, and decorative book
   title without relying on their exact text.

8. **Canonical blocks are deliberately limited to observed semantic containers.** Normal
   paragraphs, blockquotes, and Wikisource's centered/left block templates are supported. This
   is necessary because Book XI sections 30–32 use block containers and several books contain
   centered quotations. An unknown meaningful top-level container fails rather than silently
   dropping Marcus Aurelius's text.

9. **Top-level style, link, and script elements are ignored.** Wikisource inserts stylesheet
   nodes immediately before some quotation templates. They contain CSS, not canonical prose.

10. **The first content block becomes section 1 even when its decorative drop cap omits `1.`.**
    All supplied books render the first section this way. Later numbered blocks must advance by
    exactly one; gaps, repeats, or reordering are explicit errors.

11. **Unnumbered prose after a numbered block is a continuation of that section.** This covers
    multi-paragraph arguments, poetry, attributions, and closing location lines in the rendered
    source. Continuations are joined with two newlines, preserving a strong paragraph boundary
    for the downstream long-parent chunker.

12. **The parser stops at the Footnotes heading.** The complete footnote list is excluded, and
    inline `sup.reference` nodes plus dagger markers are removed. Translator insertions such as
    `[I learned]` remain because they are part of George Long's displayed translation rather
    than separate note bodies.

13. **Only presentation whitespace is normalized.** Non-breaking spaces and HTML whitespace
    runs become ordinary single spaces inside a rendered block. Curly punctuation, brackets,
    em dashes, spelling, and wording remain unchanged. No semantic correction is attempted.

14. **Decorative all-uppercase drop-cap words are restored to title case.** For example,
    rendered `FROM` becomes `From`. This applies only when the source block actually contains a
    `.dropinitial` element, avoiding generalized case rewriting.

15. **The observed canonical section counts are locked by book.** The current source yields
    17, 17, 16, 51, 36, 59, 75, 61, 42, 38, 39, and 36 sections: 487 total. A future source
    structure change must be reviewed rather than producing a plausible partial dataset.

## Parent and provenance decisions

16. **Parent IDs use the edition-specific `meditations-long-1862` namespace.** Book numbers use
    two digits and section numbers use three, matching the previously implemented child ID
    contract.

17. **`text_display` and `text_search` are initially identical.** There is no separate
    search-normalization requirement yet. Keeping both exact avoids introducing an undocumented
    second text transformation.

18. **`content_hash` is SHA-256 over UTF-8 `text_search`.** It changes precisely when searchable
    canonical parent content changes and does not depend on retrieval or embedding metadata.

19. **Every parent carries page-level provenance.** Source URL, resolved MediaWiki title, page
    ID, and revision ID make each parent traceable. The generated manifest repeats revision IDs
    at the book level so a run can be audited without scanning all parent records.

20. **No ingestion timestamp is written.** Given identical MediaWiki revisions, code, tokenizer,
    and configuration, the generated JSONL and hashes remain byte-for-byte reproducible. A wall
    clock would make otherwise identical artifacts differ.

## Output and operational decisions

21. **Parents and children are written as JSONL.** One record per line supports streaming future
    embedding/indexing jobs and avoids loading a giant JSON array. The manifest remains formatted
    JSON because humans are expected to inspect it.

22. **Generated files are replaced atomically.** Each complete file is written to a temporary
    sibling and renamed only after serialization succeeds. A fetch, parse, chunking, or validation
    failure leaves the last complete dataset untouched.

23. **The manifest stores schema, edition, API, revisions, tokenizer, chunking configuration,
    counts, and output hashes.** SHA-256 hashes of both JSONL files detect partial copies or manual
    alteration.

24. **The default output is committed under `data/generated`.** The complete generated dataset is
    roughly one megabyte, small enough to inspect and reproduce locally. Raw API HTML is not
    persisted because revision IDs provide a stable provenance pointer and only derived canonical
    records are application inputs.

25. **The pipeline validates the assembled dataset before writing.** It requires exactly 487
    unique parents, at least one child per parent, unique child IDs, and no child pointing to an
    unknown parent. Per-parent chunking validation already proves offsets, coverage, ordering, and
    token caps.

26. **The CLI requires Node 20.19 or newer and runs through `tsx`.** This matches Angular 21's
    minimum runtime, provides built-in `fetch`, and lets the checked TypeScript script remain the
    executable source. `.nvmrc` pins the locally verified Node 20.20.2 runtime.

27. **Both `ingest:meditations` and `chunk:meditations` invoke the complete pipeline.** There is no
    reason to chunk stale or hand-assembled source data by default. Both commands fetch, parse,
    validate, build parents, chunk children, and atomically replace the generated artifacts.

28. **The source-page license is referenced, not reinterpreted.** The manifest directs consumers
    to each Wikisource page's attribution and license terms. Downstream publishing must preserve
    the required attribution; this tool does not provide legal conclusions.

## Command

```bash
nvm use
npm run ingest:meditations
```

Optional paths:

```bash
npm run ingest:meditations -- \
  --sources data/sources/meditations-wiki-urls-georgelang.txt \
  --out-dir data/generated
```

Outputs:

```text
data/generated/
├── meditations-long-1862.parents.jsonl
├── meditations-long-1862.children.jsonl
└── meditations-long-1862.manifest.json
```
