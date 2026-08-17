# Meditations

A polished Angular front end for a private, reflective conversation with Marcus Aurelius. The visual system is inspired by an antique leather-bound journal while the implementation uses modern Angular patterns suitable for a production code review.

For the intended behavior, complete offline/runtime architecture, trust boundaries, and major
implementation choices, start with [`docs/system-architecture.md`](docs/system-architecture.md).
For a presenter-ready walkthrough of chunking, metadata, RAG routing, and Cal.com scheduling, use
[`docs/presentation-script-project-flows.md`](docs/presentation-script-project-flows.md).

## Highlights

- Angular 21 standalone components with strict TypeScript and zoneless change detection
- Signal-based chat and preferences stores with typed, immutable models
- Lazy-loaded Journal, Reflections, Library, and Profile routes
- Responsive, mobile-first layout with custom SCSS and no UI framework dependency
- Accessible labels, focus states, reduced-motion support, keyboard composer controls, and semantic landmarks
- Local persistence for conversation and display preferences
- Local routing, Pinecone retrieval, and OpenAI-grounded responses through a loopback-only API
- Conversation-aware meditation scheduling through an explicit Cal.com confirmation card
- Vitest unit coverage for the application shell, chat boundary, chat state, and message composer
- Pure TypeScript parent/child chunking for canonical Meditations sections

## Local development

```bash
nvm use
npm install
npm start
```

Open `http://localhost:4200`. `npm start` now launches both the Angular development server and the
loopback-only Meditations API. Angular proxies `/api` to `http://127.0.0.1:3000`, so OpenAI and
Pinecone keys stay in Node and never enter the browser bundle.

The Journal chatbot is live: it routes the message, retrieves only for `IN_SCOPE`, generates an
answer grounded in the retrieved George Long parent passages, and displays each cited child passage
verbatim in an italic blockquote with its validated Wikisource source link. A request such as
“Schedule time to meditate Tuesday at 7 PM” takes the separate `SCHEDULE` route and opens an
editable confirmation card. Cal.com receives a booking request only after the user supplies their
name and email and presses **Confirm meditation time**. `CAL_API_KEY` and `CAL_EVENT_TYPE_ID` are
required for the local API; all settings are listed in [`.env.example`](.env.example).
`DATABASE_URL` is not used by this flow.

## Quality checks

```bash
npm run build
npm test -- --watch=false
```

The optimized build is written to `dist/meditaitons`.

## MediaWiki ingestion and chunking

The source manifest is
[`data/sources/meditations-wiki-urls-georgelang.txt`](data/sources/meditations-wiki-urls-georgelang.txt).
To fetch all twelve George Long Wikisource pages, construct and validate canonical parents,
and regenerate the child chunks, run:

```bash
nvm use
npm run ingest:meditations
```

The equivalent `npm run chunk:meditations` command is also available. Generated artifacts are
written atomically to:

```text
data/generated/
├── meditations-long-1862.parents.jsonl
├── meditations-long-1862.children.jsonl
└── meditations-long-1862.manifest.json
```

To override the paths:

```bash
npm run ingest:meditations -- \
  --sources data/sources/meditations-wiki-urls-georgelang.txt \
  --out-dir data/generated
```

The checked-in run contains 487 canonical parents and 557 children. Source page IDs and revision
IDs, effective chunking configuration, tokenizer identity, record counts, and output hashes are
stored in the generated manifest. Ingestion choices and failure behavior are documented in
[`docs/ingestion-decisions.md`](docs/ingestion-decisions.md).

## Pinecone upload and verification

Copy the Pinecone entries from [`.env.example`](.env.example) into `.env`. `PINECONE_API_KEY`,
`PINECONE_INDEX`, and `PINECONE_INDEX_HOST` are required. `PINECONE_NAMESPACE` is optional and
defaults to `long-1862`. `DATABASE_URL` is not used by this command: each embedded child carries
the complete canonical parent text and provenance needed by retrieval.

For a standard 1536-dimensional dense index, also set `OPENAI_API_KEY`. The uploader defaults to
OpenAI `text-embedding-3-small`, which produces 1536-dimensional vectors. `OPENAI_BASE_URL` and
`OPENAI_EMBEDDING_MODEL` are optional overrides. Integrated Pinecone indexes do not require the
OpenAI setting.

First, validate the local files and environment without contacting Pinecone:

```bash
npm run pinecone:upsert -- --dry-run
```

Upload all 557 deterministic child records and immediately verify the namespace:

```bash
npm run pinecone:upsert
```

Repeat only the read-only preflight and verification later:

```bash
npm run pinecone:verify
```

The target may be either an integrated-embedding index whose `field_map.text` is `chunk_text`, or
a standard 1536-dimensional dense index using cosine or dot-product similarity. Standard-index
uploads generate OpenAI embeddings in batches of at most 96 and send conservative 20-vector
Pinecone batches below the 2 MB request limit. The uploader verifies generated-file hashes,
record relationships, index identity and readiness, the exact namespace count, and three sample
records. It never deletes remote records. All uploader choices and failure behavior are recorded in
[`docs/pinecone-upload-decisions.md`](docs/pinecone-upload-decisions.md).

## Querying Meditations from the terminal

Run a natural-language query against the uploaded `long-1862` namespace:

```bash
npm run pinecone:query -- "I'm hungry"
```

Change the number of returned passages or request machine-readable output:

```bash
npm run pinecone:query -- --top-k 5 "I'm anxious about tomorrow"
npm run pinecone:query -- --json "I want revenge"
```

Run the checked-in 20-scenario smoke suite:

```bash
npm run pinecone:query:test
```

Every prompt first passes through a six-way server-side router: `IN_SCOPE`, `SCHEDULE`, `REFRAME`,
`OUT_OF_SCOPE`, `NEEDS_CLARIFICATION`, or `SAFETY`. Only `IN_SCOPE` reaches the embedding endpoint
or Pinecone. The command prints the route and whether retrieval was allowed; allowed queries use
the same OpenAI model and 1536 dimensions as the indexed children and print the matching canonical
reference, similarity score, child text, parent context, and source URL.

Run the 27-case routing regression suite without querying Pinecone:

```bash
npm run routing:test
```

The routing suite covers ambiguous and explicit self-harm, violence, abuse, medication advice,
eating-disorder language, reality distress, prompt injection, unrelated requests, reframing,
empty/nonsense/long inputs, slang, multilingual input, corpus questions whose answer may not
exist, and the distinction between scheduling and asking about meditation frequency. Query design choices are recorded in
[`docs/pinecone-query-decisions.md`](docs/pinecone-query-decisions.md); routing and safety decisions
are recorded in
[`docs/conversation-routing-decisions.md`](docs/conversation-routing-decisions.md).

The localhost API, browser boundary, grounded answer contract, and UI failure behavior are
documented in [`docs/localhost-chat-decisions.md`](docs/localhost-chat-decisions.md).
Scheduling-specific consent, time-zone, Cal.com, and duplicate-prevention decisions are documented
in [`docs/scheduling-decisions.md`](docs/scheduling-decisions.md).

## Terminal pipeline logs

While `npm start` is running, the API terminal now shows the decision process for every request:

- `[pipeline]` one-line JSON records stage start, success/error, and duration;
- `[routing]` readable JSON explains the selected route and which branch will run; and
- `[scheduling]` readable JSON shows extraction, default use, clarification/card selection, the
  confirmation boundary, and the final Cal.com outcome.

Every line for one request shares an `X-Request-Id`. API keys, attendee names/emails, raw provider
responses, and booking identifiers are excluded. Full field and privacy decisions are documented in
[`docs/observability-decisions.md`](docs/observability-decisions.md).

## Architecture

The full architecture and behavioral contract are documented in
[`docs/system-architecture.md`](docs/system-architecture.md). In brief:

```text
src/app/
├── core/       typed models and singleton signal stores
├── features/   lazy-loaded routed screens
├── shared/     reusable presentational components
└── app.*       responsive application shell and navigation
```

`ChatStore` owns front-end conversation state and calls the same-origin `/api/chat` adapter. The
server owns routing, secrets, embedding, Pinecone retrieval, grounded answer generation, and the
Cal.com booking action.

The backend-ready chunking layer lives in `src/app/core/chunking`. Its public API,
invariants, algorithm choices, and extension points are recorded in
[`docs/chunking-decisions.md`](docs/chunking-decisions.md).

## Asset note

The Marcus Aurelius portrait in `public/assets/marcus-aurelius.png` was generated specifically for this project and optimized for circular avatar crops.
# meditAItons
