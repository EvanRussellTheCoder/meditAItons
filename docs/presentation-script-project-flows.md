# Presentation script: from source text to grounded guidance and scheduled practice

This script is designed for roughly nine minutes. The quoted paragraphs are presenter-ready; the
“Show” notes identify the visual or code to keep on screen. For a five-minute version, combine
slides 2 and 3, combine slides 4 and 5, and omit the alternatives paragraphs on slides 5 and 10.

## Slide 1 — One application, two controlled flows (45 seconds)

**Show:** The architecture diagram from `docs/system-architecture.md`, simplified to these paths:

```text
Wikisource -> parents -> children + metadata -> embeddings -> Pinecone
                                                        |
User -> selector -> IN_SCOPE -> retrieve -> grounded answer + exact quote
                \-> SCHEDULE -> proposal card -> confirmation -> Cal.com
```

**Say:**

“MeditAItons has one offline data flow and two possible runtime action flows. Offline, it turns the
George Long translation of _Meditations_ into a traceable semantic-search corpus. At runtime, every
message first reaches a selector. An in-scope philosophical question can use retrieval-augmented
generation, or RAG. A request to schedule meditation takes a separate scheduler route. That route
does not search the book, and it cannot write to Cal.com until the user confirms a visible card.

The architectural theme is separation of responsibilities. Chunking improves retrieval, metadata
preserves meaning and provenance, routing decides which capabilities are allowed, and explicit
confirmation controls the only external write.”

**Code to open:**

- Offline entry point: `scripts/ingest-meditations.ts`, `main`
- Runtime entry point: `scripts/chat-api.ts`, `main` and the `/api/chat` request handler
- Runtime orchestrator: `src/app/core/chat/meditations-chat.ts`, `MeditationsChatService.respond`

## Slide 2 — Ingestion creates canonical parents (55 seconds)

**Show:** One input URL, then a parent such as `meditations-long-1862-b01-s001` with reference
`1.1`, its full verse, content hash, and Wikisource revision ID.

**Say:**

“The corpus starts with a text manifest containing one English Wikisource URL for each of the
twelve books. The ingestion script converts each URL into a MediaWiki Action API request. MediaWiki
renders the page; the local parser then extracts the numbered verses. A verse—not a web page and
not an arbitrary token window—is the canonical parent document.

Each parent gets a deterministic ID, a human-readable book-and-section reference, the complete
George Long text, edition identity, a SHA-256 content hash, and page and revision provenance. The
parser also requires the expected section order and total of 487 parents. If Wikisource changes in
a way that produces a partial or reordered book, ingestion stops rather than publishing a
plausible-looking but corrupt dataset.

This is an important decision: the MediaWiki API supplies rendered source material and revision
identity, while this application decides what a canonical philosophical unit is.”

**Code to open:**

- URL loading, API fetch, orchestration, validation, and atomic output:
  `scripts/ingest-meditations.ts`
- Verse extraction: `src/app/core/ingestion/parse-book.ts`,
  `parseMeditationsBookDocument`
- Parent IDs, hashes, edition fields, and provenance:
  `src/app/core/ingestion/parse-book.ts`, `buildParentRecords`

## Slide 3 — Adaptive parent/child chunking (75 seconds)

**Show:** A short, medium, and long parent branching into children. Label the thresholds and show
that every child points back to exactly one parent.

**Say:**

“The chunker treats the complete verse as canonical but creates smaller children for semantic
search. It first counts tokens. A parent of at most 180 tokens remains one child. A medium parent,
up to 400 tokens, is segmented by sentences and packed toward 120 to 180 tokens. A longer parent is
segmented by paragraphs and then sentences and packed toward 150 to 220 tokens. Every child has a
hard ceiling of 260 tokens.

If one structural unit is still too large, the fallback order is semicolon, colon, em dash, and
finally a Unicode-safe token split. A later child may repeat one complete sentence from the prior
child, but only when that overlap is no more than 80 tokens, less than 40 percent of the child, and
still below the hard maximum.

This adaptive policy was chosen over fixed-size windows because prose meaning usually follows
verse, paragraph, and sentence boundaries. Fixed windows are simpler, but they can cut an argument
mid-sentence. Keeping every verse whole would preserve context, but a long verse can dilute the
semantic signal. Parent/child chunking gives search a focused child while giving answer generation
the complete parent.”

**Code to open:**

- Thresholds and version: `src/app/core/chunking/config.ts`
- Classification, segmentation choice, packing, overlap, and child creation:
  `src/app/core/chunking/chunk-parent.ts`, `chunkParent`
- Boundary rules: `src/app/core/chunking/segmentation.ts` and
  `src/app/core/chunking/overlap.ts`
- Exact-slice and coverage checks: `src/app/core/chunking/validation.ts`

**Plain-English pseudocode:**

```text
count parent tokens
if short, keep the verse whole
otherwise split on natural boundaries and pack near the target size
add a small previous-sentence overlap only when safe
slice children from the original text and validate every offset
```

## Slide 4 — Metadata is the connective tissue (65 seconds)

**Show:** One Pinecone record divided into four groups: retrieval, hierarchy, citation, and
provenance.

**Say:**

“A child vector is useful only if its meaning can be reconstructed and audited. Before upload,
`createPineconeRecords` joins every child to its parent and rejects unknown parent IDs or a child
whose offsets do not reproduce its exact text.

The record stores `chunk_text` for embedding and matching. It stores `parent_id` and the complete
`parent_text` for generation context. It stores `canonical_ref`, child index, offsets, and token
count for hierarchy and exact citation. It also stores edition, translator, year, source URL, page
ID, revision ID, and parent content hash for provenance. Finally, it stores the embedding model and
dimensions so the runtime can reject a corpus created with incompatible vectors.

Duplicating the parent text in each child record spends some metadata space, but this corpus is
small and the result is a simpler, faster runtime with no second database lookup. That is why a
`DATABASE_URL` is not part of this flow. A larger corpus could normalize parents into a database,
but then retrieval would require another network dependency and another consistency boundary.”

**Code to open:**

- Record join and metadata construction: `src/app/core/pinecone/records.ts`,
  `createPineconeRecords`
- Embedding metadata and dimension validation: the same file,
  `createPineconeVectorRecords`
- Metadata types: `src/app/core/pinecone/types.ts`

## Slide 5 — Embedding, upload, and verification (50 seconds)

**Show:** `557 children -> text-embedding-3-small -> 1536 numbers each -> Pinecone long-1862`.

**Say:**

“The checked-in dataset contains 487 parents and 557 searchable children. The uploader validates
the generated manifest and file hashes before contacting a provider. For the standard dense index,
it embeds each `chunk_text` with OpenAI’s `text-embedding-3-small`, producing 1536 dimensions, then
upserts conservative batches into the `long-1862` namespace.

Upload is not considered complete just because Pinecone accepted a request. Verification waits for
eventual consistency, checks the exact namespace count, and fetches representative records to
confirm required fields. It never deletes unexpected remote data automatically. Reproducible IDs
make a repeat upload an upsert, while the manifest records exactly which source revision and
chunking configuration produced the corpus.”

**Code to open:**

- CLI mode selection, local validation, embedding batches, vector upsert, and verification:
  `scripts/pinecone.ts`
- OpenAI embedding client: `src/app/core/pinecone/openai-embeddings.ts`
- Pinecone REST boundary: `src/app/core/pinecone/pinecone-rest.ts`

## Slide 6 — The selector decides whether RAG is allowed (85 seconds)

**Show:** A six-way decision with only one arrow reaching Pinecone.

```text
IN_SCOPE ----------> retrieve
SCHEDULE ----------> proposal card
REFRAME ------------> bounded reflective response
OUT_OF_SCOPE -------> scope boundary
NEEDS_CLARIFICATION -> clarification
SAFETY -------------> safety response
```

**Say:**

“Every chat turn is classified before embedding or retrieval. The six public routes are
`IN_SCOPE`, `SCHEDULE`, `REFRAME`, `OUT_OF_SCOPE`, `NEEDS_CLARIFICATION`, and `SAFETY`. The request
is normalized with a bounded window of recent user messages. Deterministic checks handle invalid
input and high-signal urgent safety language first. Remaining messages pass through moderation,
then a structured scope classifier.

The central authorization rule is simple: `retrieve` is true only for `IN_SCOPE`. A schedule
request is therefore not merely a different answer prompt—it is a different capability branch.
Remote decision failures also fail closed to clarification instead of guessing that retrieval is
safe.

An alternative would be to retrieve first and let the answer model decide relevance. That wastes
provider calls, sends unrelated or sensitive text farther through the pipeline, and makes policy
behavior harder to test. Routing first makes the decision visible, logged, and enforceable in
ordinary application code.”

**Code to open:**

- Decision sequence: `src/app/core/routing/router.ts`, `ConversationRouter.route`
- Deterministic checks, route-to-response mapping, and the `retrieve` flag:
  `src/app/core/routing/policy.ts`
- Structured classifier: `src/app/core/routing/openai-scope-classifier.ts`
- Branch enforcement: `src/app/core/chat/meditations-chat.ts`,
  `MeditationsChatService.respond`

## Slide 7 — RAG retrieves children but reasons over parents (80 seconds)

**Show:** `question -> query vector -> top 5 children -> at most 4 unique parents -> answer`, with
the exact child quotation bypassing the prose generator.

**Say:**

“For an `IN_SCOPE` message, the server creates a 1536-dimensional query embedding and asks
Pinecone for the top five children. It validates that each match reports the expected embedding
model and dimensions. It then deduplicates matches to at most four unique parents, allows only
trusted English Wikisource URLs, and verifies that every child quote is an exact substring of its
parent.

The answer model receives the user message, bounded history, and complete retrieved parents. A
structured output forces it to report whether evidence is sufficient and which canonical
references support the answer. If the evidence is insufficient, application code returns a fixed
abstention.

The model writes the connective prose, but it does not write the displayed quotation. After the
model selects a reference, application code attaches the retrieved child text verbatim. This
design is stronger than asking a language model to reproduce a quotation from memory: the visible
italics are traceable source text, and their source link comes from validated metadata.”

**Code to open:**

- Embedding, query, match validation, evidence construction, and citation attachment:
  `src/app/core/chat/meditations-chat.ts`, `respond` and `createEvidence`
- Structured grounded-answer contract: `src/app/core/chat/openai-grounded-answer.ts`,
  `OpenAIGroundedAnswerClient.generate`
- Front-end quote rendering: `src/app/shared/message/message.html`

## Slide 8 — Scheduling starts with a proposal, not a booking (80 seconds)

**Show:** A user message such as “Schedule meditation Tuesday at 7 PM,” followed by the editable
confirmation card.

**Say:**

“When the selector returns `SCHEDULE`, RAG is skipped. The scheduling extractor receives the
current message, bounded conversation history, the browser’s validated IANA timezone, and the
current local date. Structured output either resolves a date and time or asks a clarification.
This context allows a follow-up such as ‘Tuesday at 7’ to complete an earlier scheduling request.

If only a date or time is missing, the application can show an editable default: the next weekday
or 9 AM. Contradictory choices or an ambiguous time produce a question instead of a guess. A valid
proposal receives a random ID, remains in server memory for 30 minutes, and appears as an editable
card. At this point Cal.com has not been contacted.

The user supplies name and email only in the card and explicitly presses Confirm. Those identity
fields never go to the routing or scheduling models and are not persisted in local storage. This
two-step flow adds a small interaction cost, but it prevents a language-model interpretation from
silently creating a calendar event.”

**Code to open:**

- Conversation-aware structured extraction:
  `src/app/core/scheduling/openai-scheduling.ts`, `OpenAISchedulingExtractor.extract`
- Defaults, proposal TTL, and one-time state:
  `src/app/core/scheduling/meditation-scheduler.ts`, `MeditationScheduler.propose`
- Card UI: `src/app/shared/scheduling-card/scheduling-card.ts` and
  `src/app/shared/scheduling-card/scheduling-card.html`
- Browser state and confirmation request: `src/app/core/services/chat.store.ts` and
  `src/app/core/services/chat-api.client.ts`

## Slide 9 — Confirmation is the Cal.com write boundary (80 seconds)

**Show:** `pending -> in_flight -> booked`, with a separate `uncertain` branch that blocks retry.

**Say:**

“The confirmation endpoint validates the proposal, attendee fields, date, time, and timezone. It
rejects expired or already-submitted proposals, converts the local wall-clock time to UTC, rejects
past times, and explicitly detects daylight-saving times that do not exist or occur twice.

Only then does the proposal move from pending to in-flight and call Cal.com. At startup, the
Cal.com client has already preflighted the configured event type, learned its duration, and rejected
unsupported required booking fields. The booking POST contains the UTC start, event type ID,
attendee timezone and identity, title, and proposal metadata. Provider availability and booking
limits remain enabled.

The POST is never automatically retried. A definite availability or validation failure can return
the proposal to a retryable state. A timeout, server error, or malformed success response is
different: Cal.com might have created the event even if the response was lost. The proposal becomes
`uncertain`, and another POST is blocked to avoid a duplicate. A production multi-instance system
would replace the in-memory proposal registry with authenticated durable idempotency storage.”

**Code to open:**

- Confirmation state machine and local-to-UTC conversion:
  `src/app/core/scheduling/meditation-scheduler.ts`, `MeditationScheduler.confirm` and
  `localWallClockToUtc`
- Event-type preflight, booking payload, and error classification:
  `src/app/core/scheduling/cal-com.ts`, `CalComClient.initialize` and `CalComClient.book`
- HTTP consent boundary: `scripts/chat-api.ts`, the `/api/schedule` handler

## Slide 10 — Observable, testable decisions (55 seconds)

**Show:** A terminal trace containing `[pipeline]`, `[routing]`, and `[scheduling]` lines sharing one
request ID.

**Say:**

“These flows are intentionally observable. Each request has a correlation ID. Pipeline logs show
stage start, success or failure, and duration. Routing logs show the selected route and the next
branch. Scheduling logs show extracted constraints, visible defaults, clarification versus card,
the confirmation boundary, and the final Cal.com outcome. They exclude API keys, attendee names
and emails, raw provider bodies, and booking IDs.

The result is a system whose important decisions are visible at three levels: deterministic corpus
artifacts, typed runtime branches, and privacy-bounded logs. The design does not ask one language
model to ingest, retrieve, answer, and schedule. It gives each uncertain model task a narrow schema,
then surrounds it with deterministic validation and explicit application-level authority.

That is the core flow of MeditAItons: preserve the source, retrieve only when allowed, show the
source’s exact words, and require human confirmation before acting outside the conversation.”

**Code to open:**

- Correlated stage and decision logs: `src/app/core/observability/observability.ts`
- API wiring and request IDs: `scripts/chat-api.ts`
- Regression coverage: `src/app/core/**/*.spec.ts`, `scripts/routing-test.ts`, and
  `scripts/pinecone-query-test.ts`

## Optional live demonstration

1. Start the application with `npm start` and keep the API terminal visible.
2. Ask, “I am angry with someone—how should I respond?” Show the route, retrieval stages, grounded
   answer, italic exact quote, and source link.
3. Ask, “Schedule time to meditate Tuesday at 7 PM.” Show that the route is `SCHEDULE`, no
   Pinecone stage appears, and a confirmation card opens.
4. Edit the proposed details. Explain that pressing Confirm is the first point at which Cal.com
   receives a write request. Use a test event type if the demonstration should create a real event.

## Why the explanatory comments live where they do

The repository now includes short “Plain-English pseudocode” blocks at the orchestration boundaries
for ingestion, chunking, metadata construction, routing, chat/RAG, scheduling proposals, and the
Cal.com client. These locations were chosen because they answer “what happens next?” without
restating individual TypeScript expressions. Lower-level helpers retain descriptive names and tests
instead of duplicate comments, which reduces the risk that prose drifts away from behavior.
