# Meditations Pinecone query testing: implementation decisions

This log records the choices made for terminal retrieval and its 20-query smoke suite.

1. **Queries use the same embedding model as indexed children.** The CLI defaults to OpenAI
   `text-embedding-3-small` with an explicit 1536 dimensions. Mixing models or dimensions would
   make similarity scores meaningless even if Pinecone accepted the vector. The model and
   dimension are also checked on every returned match.

2. **The command routes before Pinecone preflight or embedding.** Only `IN_SCOPE` prompts are
   allowed to proceed. For those prompts it confirms the name and host identify the same ready,
   standard, dense 1536-dimensional index before spending the embedding request.

3. **Vector search uses `POST /query`.** Requests provide the namespace, query vector, `topK`,
   `includeMetadata: true`, and `includeValues: false`. Metadata is required to reconstruct the
   canonical citation and parent context; returning 1536 stored floats would add latency and noise
   without helping terminal output. This follows Pinecone's
   [vector-query contract](https://docs.pinecone.io/reference/api/2025-10/data-plane/query).

4. **The default result count is three.** Three passages are enough to inspect ranking variety
   without flooding a terminal. `--top-k` accepts 1–20 so a developer can widen the result set
   deliberately while keeping interactive output bounded.

5. **Custom prompt arguments are joined after shell parsing.** Quoting the prompt is recommended,
   but the CLI still treats multiple non-option arguments as one prompt. Empty prompts, unknown
   flags, invalid result counts, and combining a custom prompt with `--suite` fail explicitly.

6. **Human output emphasizes traceability.** A custom query prints score, canonical reference,
   child passage, parent context, and Wikisource URL. Whitespace is normalized and long text is
   truncated only for display; Pinecone metadata is not changed.

7. **`--json` preserves complete returned match metadata.** This makes the CLI usable from shell
   scripts and future evaluation tooling without adding a second query implementation.

8. **The retrieval smoke suite contains exactly 20 short first-person situations.** It includes the three
   requested examples plus anger, anxiety, loneliness, regret, admiration, mortality, low
   motivation, insult, jealousy, overwork, lack of control, ingratitude, decision-making,
   procrastination, grief, success, and revenge. Unique stable IDs make future result snapshots
   comparable.

9. **Only suite prompts routed `IN_SCOPE` are embedded.** Eligible prompts share one OpenAI
   embedding request, remain below the validated batch ceiling, and are reordered by the indices
   returned from OpenAI. Blocked prompts are reported without touching Pinecone.

10. **Routing and Pinecone suite requests use four concurrent workers.** This bounds load while
    reducing serial latency. Results are stored and printed in original suite order, so network
    completion order never changes the report.

11. **The suite is a retrieval smoke test, not a ground-truth relevance benchmark.** It proves
    that embedding, query, metadata, ordering, and result presentation work across varied intents.
    A formal quality evaluation would additionally require human-authored expected references or
    graded relevance judgments.

12. **A model classifies scope but does not generate the philosophical answer.** Non-retrieval
    responses are fixed application templates (except for a bounded reflective reframe question).
    `IN_SCOPE` output remains raw retrieval evidence so ranking can be judged before a later RAG
    response layer adds grounded prose generation.

13. **The CLI remains server-only.** OpenAI and Pinecone keys load from `.env` in Node and never
    enter Angular client code, command output, query metadata, or URLs.

14. **The query command is read-only.** Every non-deterministic prompt incurs moderation and routing
    requests. Only `IN_SCOPE` prompts incur an embedding request and Pinecone read units. The
    command never upserts, updates, or deletes Pinecone data.

15. **Tests cover the wire shape and suite contract.** Unit tests verify Pinecone query payloads,
    response parsing, the exact suite size, unique IDs, non-empty text, and inclusion of the three
    requested prompts. Live smoke execution remains necessary to assess semantic usefulness.

16. **Embedding validation errors report structure, never vector contents.** When the live suite
    exposed a transient invalid-embedding response, validation was made specific enough to identify
    an invalid index, missing array, dimension mismatch, non-finite value, or duplicate index. It
    still omits all embedding values and user text from the error.
