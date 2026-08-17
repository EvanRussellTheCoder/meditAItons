# Meditations Pinecone upload: implementation decisions

This log records every implementation choice made for the generated-chunks-to-Pinecone step and
why it was made. It covers `scripts/pinecone.ts` and the server-only code in
`src/app/core/pinecone`. Source ingestion and chunk-boundary decisions remain in their separate
logs.

## Record and index decisions

1. **Only child chunks are embedded as Pinecone records.** Retrieval needs the focused child
   passage as its similarity-search unit. Uploading parents as additional embedded records would
   mix two granularities in one result set and could return duplicate versions of the same text.

2. **Each child includes its complete canonical parent text as metadata.** This preserves the
   parent/child retrieval contract without requiring a second database lookup. Consequently,
   `DATABASE_URL` is not read by this uploader. A future application may still put parents in a
   relational database for other features, but that is a separate concern.

3. **Both integrated and standard dense indexes are supported.** For an integrated index,
   `chunk_text` contains the child's exact `text_search`, and the command requires
   `embed.field_map.text` to equal `chunk_text`. For a standard index, the command requires dense
   1536-dimensional vectors with cosine or dot-product similarity and generates the vectors
   before upsert. Other shapes fail before data is written.

4. **Standard-index embeddings default to OpenAI `text-embedding-3-small`.** Its native output is
   exactly 1536 dimensions, matching the existing `meditations` index without resizing or
   recreating it. The request still specifies `dimensions: 1536`, and every returned vector is
   checked for that exact length and finite numeric values. The official
   [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings#how-to-get-embeddings)
   documents the model's default dimensionality.

5. **The deterministic child ID becomes Pinecone `_id` or vector `id`.** Repeating the command upserts the same
   IDs instead of creating duplicates. This makes interrupted uploads safe to rerun, although it
   does not remove obsolete IDs from an earlier dataset.

6. **Metadata stays flat and filter-friendly.** Parent ID, canonical reference, book, section,
   child index, offsets, token count, work, edition, translator, year, source URL, MediaWiki page
   title, page ID, revision ID, parent content hash, parent text, child text, embedding model, and
   embedding dimensions are top-level fields. Flat values avoid ambiguous serialization and make
   future filters straightforward.

7. **The full parent source and content hash accompany every child.** The URL and MediaWiki IDs
   identify the external revision; the parent hash identifies the exact locally indexed text.
   This is intentional metadata duplication in exchange for traceable, one-read retrieval.

8. **The command rejects records above a conservative 40 KiB serialized limit.** Pinecone's
   metadata limit is 40 KiB per record. Measuring the entire outgoing JSON object, including the
   ID and embedding text, is stricter than measuring metadata alone and therefore fails locally
   before a likely remote rejection.

## API and configuration decisions

9. **The uploader uses Pinecone's server-side REST API at version `2026-04`.** The required
   surface is small, so a focused client avoids adding an SDK dependency while keeping each
   endpoint and payload explicit. The implementation follows Pinecone's official
   [upsert-records reference](https://docs.pinecone.io/reference/api/2026-04/data-plane/upsert_records).

10. **Integrated text records are sent as newline-delimited JSON.** Every line is one record and
    the request uses `application/x-ndjson`, matching the current upsert contract. A trailing
    newline is included so each record, including the final one, is a complete NDJSON line.

11. **Standard embeddings use OpenAI's REST endpoint directly.** The request uses bearer
    authentication, float encoding, an explicit model and dimension, and an ordered string array.
    Responses are reordered by their returned indices and rejected for missing, duplicate,
    malformed, non-finite, or wrong-sized vectors. This avoids adding an SDK for one endpoint.

12. **Embedding batches contain at most 96 texts and standard Pinecone batches contain at most 20
    vectors.** Ninety-six matches the established text batch size and keeps each OpenAI request
    well below the current corpus's token volume. Twenty 1536-dimensional vectors plus worst-case
    accepted metadata remain conservatively below Pinecone's fixed 2 MB request limit. The client
    also measures every final JSON payload and rejects an oversized one locally. Pinecone documents
    the [vector-upsert shape](https://docs.pinecone.io/reference/api/2026-04/data-plane/upsert) and
    [2 MB batch limit](https://docs.pinecone.io/guides/index-data/upsert-data).

13. **Integrated batches contain at most 96 text records and upload sequentially.** Ninety-six is
    Pinecone's documented integrated-embedding batch limit. Six predictable requests are enough
    for the current 557 records, and sequential requests make progress and failures unambiguous.
    See Pinecone's [upsert limits](https://docs.pinecone.io/guides/index-data/upsert-data).

14. **The data-plane host comes only from `PINECONE_INDEX_HOST`.** The host accepts either a bare
    hostname or an HTTPS URL but rejects paths, credentials, query strings, fragments, and non-HTTPS
    protocols. Requests never target a guessed host.

15. **`PINECONE_INDEX` is also required for a control-plane safety preflight.** The command
    describes that named index, requires it to be ready, and confirms the returned host matches
    `PINECONE_INDEX_HOST`. This prevents a valid key plus a copied host/name mismatch from writing
    to the wrong index. Pinecone likewise recommends [targeting an index by its unique
    host](https://docs.pinecone.io/guides/manage-data/target-an-index).

16. **The default namespace is the edition ID `long-1862`.** It keeps this translation isolated
    and makes the default visible and deterministic. `PINECONE_NAMESPACE` or `--namespace` may
    override it when a deliberate environment-specific namespace is needed.

17. **Secrets load from `.env` only in the Node CLI.** `.env` and `.env.*` are ignored, while
    `.env.example` is committed with placeholders. Neither API key is put in Angular environment
    code, record metadata, URLs, progress output, or error messages. `OPENAI_BASE_URL` defaults to
    the official `/v1` endpoint and any override must be HTTPS without embedded credentials,
    query, or fragment.

18. **No database credentials are required.** `DATABASE_URL` remains in `.env.example` only to
    clarify that another backend feature may use it. Requiring or testing an unrelated database
    would create an unnecessary failure mode for a Pinecone-only operation.

## Local validation decisions

19. **The generated manifest controls filenames, counts, edition, and hashes.** Before creating a
    client, the CLI parses the manifest, resolves both JSONL files inside the selected data
    directory, verifies their SHA-256 hashes, and requires their line counts to match. This catches
    partial copies, edits, and stale file combinations before any remote call.

20. **Manifest paths cannot be absolute or escape the data directory.** Although the checked-in
    manifest is trusted, enforcing this boundary prevents a changed manifest from causing the
    uploader to read arbitrary local files.

21. **Every child is rejoined to its parent before upload.** Duplicate parent or child IDs,
    missing parents, mismatched canonical references, incorrect source slices, or missing source
    provenance are fatal. The upload therefore does not merely trust that two independently read
    JSONL files still correspond.

22. **`--dry-run` validates configuration and all local data but makes zero remote requests.**
    It is intended as the first operational check. It confirms record and batch counts without
    testing remote credentials or index configuration; those checks necessarily occur in the
    live command.

## Retry, failure, and verification decisions

23. **Network failures, HTTP 429, and HTTP 5xx receive at most four attempts.** Retry delays are
    deterministic exponential backoff (500, 1,000, and 2,000 ms) unless Pinecone supplies a
    numeric `Retry-After`, capped at 30 seconds. The policy applies independently to OpenAI and
    Pinecone. Other HTTP failures are not retried because they usually require a configuration or
    permission change.

24. **The uploader stops on the first failed batch.** It reports completed batches and exits
    nonzero. Already accepted batches remain, and rerunning safely replaces those deterministic
    IDs before continuing through the complete dataset.

25. **Post-upload verification waits up to roughly 30 seconds for namespace consistency.** The
    command polls Pinecone's current
    [describe-namespace endpoint](https://docs.pinecone.io/reference/api/2026-04/data-plane/describenamespace)
    fifteen times at two-second intervals. A temporarily absent namespace counts as zero during
    this bounded post-upload window.

26. **The namespace count must equal exactly 557 (or the manifest's future child total).** A lower
    count means the write is incomplete. A higher count indicates stale or unrelated records.
    Exact equality makes that condition visible instead of reporting a misleading success.

27. **The command never deletes a namespace or stale records automatically.** Destructive cleanup
    requires a deliberate migration decision. If the count is too high, verification fails and
    explicitly states that nothing was deleted.

28. **Verification fetches the first, middle, and last expected IDs.** It checks that all three
    exist and that `parent_id`, `canonical_ref`, and `edition_id` match local records. For standard
    indexes it also checks `embedding_model` and `embedding_dimensions`, preventing a successful
    count from hiding vectors created by the wrong model. Pinecone's
    [fetch endpoint](https://docs.pinecone.io/reference/api/2026-04/data-plane/fetch) is used instead
    of a semantic query, so embedding score variation cannot affect the check.

29. **`pinecone:verify` performs no writes and does not wait for convergence.** It repeats the
    index safety preflight, exact count, and sample fetch once. This makes it suitable as a quick
    later health check; a failure is immediate and visible to automation.

30. **Failures use stable categories and a nonzero process exit.** Local-data, configuration,
    index readiness/mismatch, embedding-request, Pinecone-request, and verification failures are
    distinguishable. Remote response details are whitespace-normalized and truncated to keep logs
    useful without dumping large bodies.

## Commands

Validate locally without network access:

```bash
npm run pinecone:upsert -- --dry-run
```

Upload and verify:

```bash
npm run pinecone:upsert
```

Verify later without writing:

```bash
npm run pinecone:verify
```

Optional overrides:

```bash
npm run pinecone:upsert -- \
  --namespace long-1862 \
  --data-dir data/generated
```
