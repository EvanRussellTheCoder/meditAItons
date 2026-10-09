# Runtime observability: implementation decisions

This log records the decisions behind the local API's terminal output and optional LangSmith
tracing. The terminal format intentionally resembles the Parsity medical RAG application's
observability: compact pipeline events for machines and readable decision summaries for people.

1. **Every chat or scheduling request receives a correlation ID.** A caller may supply
   `X-Request-Id` only when it contains 1–128 letters, digits, periods, underscores, or hyphens.
   Otherwise the server generates a UUID. The same ID appears in the response header and every log
   line produced by that request, so interleaved requests remain traceable.

2. **Stage telemetry uses one-line `[pipeline]` JSON.** Start, success, and error events record the
   request ID and stage. Completed stages include duration in milliseconds; failures include only a
   bounded status, error class, and stable error code. One-line JSON is easy to scan, grep, or feed
   into a log collector.

3. **The measured stages reflect architectural boundaries.** Startup measures Cal.com and Pinecone
   preflight. Runtime measures selector, scheduling extraction, query embedding, Pinecone search,
   grounded answer generation, and confirmed Cal.com booking. A stage is absent when its branch did
   not run, making “no retrieval on SCHEDULE” visible in the terminal.

4. **Routing gets a readable `[routing]` summary.** It prints route, reason code, plain-language
   explanation, decision source, and derived booleans for retrieval, scheduler, safety response,
   and clarification. These fields are derived from the typed routing decision so the booleans
   cannot disagree with the selected route.

5. **Scheduling gets readable `[scheduling]` summaries.** Proposal logs distinguish extracted from
   default date/time values, name the ambiguity state, and state whether the app will ask a question
   or show a confirmation card. Confirmation logs make the human-consent boundary explicit.
   Calendar-result logs distinguish confirmed, definitely rejected, and uncertain outcomes.

6. **A successful proposal explicitly logs `calendarWritePerformed: false`.** This prevents a
   proposal from looking like a booking. Only the confirmation phase logs a permitted calendar
   write, matching the UI's human-in-the-loop contract.

7. **Request completion is logged even for rejected input.** Method, path, HTTP status, duration,
   and stable error code make request validation, proposal expiry, duplicate blocking, and provider
   failure visible without returning raw internals to the browser.

8. **Logs exclude secrets and attendee identity.** API keys, authorization headers, raw provider
   bodies, exception messages, attendee name, attendee email, and Cal.com booking UID are never
   printed. Scheduling logs expose only `attendeeNameProvided`, `attendeeEmailProvided`, and
   `bookingUidPresent` booleans. This preserves useful control-flow evidence without copying contact
   information into the terminal.

9. **The current chat message is a bounded local preview.** The routing summary shows at most 180
   normalized characters because, like the reference application, seeing the routed query is useful
   during development. Email-like strings are replaced with `[EMAIL REDACTED]`, and newlines/tabs
   are removed to prevent forged log lines. Conversation history content is not printed; only its
   message count is logged.

10. **Core observability is inert without a request ID.** Unit-level callers that use the reusable
    chat and scheduling classes directly do not produce terminal noise. The HTTP server supplies the
    ID in live use, while observability tests opt in with a fixed ID.

11. **Logging does not change control flow.** Stage observation rethrows the original error after
    recording safe metadata. Routing and scheduling summaries consume already-validated application
    decisions; they do not ask another model to interpret the result.

12. **Startup prints a non-secret configuration summary.** The local URL, namespace, model names,
    scheduling availability, duration, and confirmation requirement are shown after both provider
    preflights pass. Hosts, credentials, and provider response bodies are excluded.

13. **LangSmith is an optional server-only mirror of the runtime pipeline.** The API dynamically
    loads the `langsmith` package only after `.env` is available. Angular code never imports the SDK,
    and the existing OpenAI, Pinecone, Cal.com, and terminal-observability behavior remains
    authoritative.

14. **External tracing is disabled by default and excludes startup preflights.**
    `LANGSMITH_TRACING=true` requires `LANGSMITH_API_KEY`; otherwise no LangSmith runtime is loaded
    and no trace upload occurs. The tracer is registered only after Cal.com and Pinecone preflight,
    so the project contains runtime `/api/chat` and `/api/schedule` work rather than startup noise.

15. **Trace content requires a second synthetic-data opt-in.** With
    `MEDITATIONS_LANGSMITH_CAPTURE_CONTENT=false`, spans contain structural fields only: stage and
    request IDs, routes, models, namespaces, counts, dimensions, references, scores, scheduling
    status, and safe errors. Setting it to `true` also records chat text, history, retrieved evidence,
    and generated text. This mode is for synthetic development prompts only.

16. **Sensitive fields remain excluded even in content mode.** Attendee name/email, booking UID,
    credentials, authorization values, raw embedding vectors, and raw provider errors are never
    intentionally projected into traces. A final recursive sanitizer redacts sensitive field names,
    email-like values, and recognizable secret formats and bounds strings, arrays, and nesting.

17. **Tracing is fail-open after valid startup configuration.** Invalid opt-in configuration fails
    startup visibly. Runtime trace transport, projection, or flush failure produces only a safe
    warning and preserves the original application result or error without rerunning side effects.
    Pending trace batches are flushed on graceful API shutdown.

18. **Every router outcome has a verified live trace shape.** Synthetic end-to-end checks performed
    on 2026-10-09 covered all six routes. `IN_SCOPE` produced `selector`, `embedding`, `pinecone`,
    and `grounded_answer`; `SCHEDULE` produced `selector` and `scheduling`; `REFRAME`,
    `OUT_OF_SCOPE`, `NEEDS_CLARIFICATION`, and `SAFETY` each produced only `selector`. Every child
    was nested beneath one successful `meditaitons.chat` root, and blocked routes produced no
    retrieval or scheduling spans.

19. **The confirmation error path has been observed end to end.** A synthetic `/api/schedule`
    request produced a separate
    `meditaitons.schedule_confirmation` root with a nested `cal.com` tool span. Cal.com rejected the
    placeholder attendee email as non-deliverable, so both spans correctly ended in error and no
    booking was created. The provider message was inspected only as a bounded local diagnostic; it
    was not projected into LangSmith.

20. **Both privacy modes have live verification.** With synthetic-content capture enabled, the
    expected prompt, evidence, and answer projections appeared while credentials, attendee
    identity, booking UID, and vectors remained absent. With content capture disabled, route tests
    contained only structural input/output fields and none of the synthetic prompt text. A separate
    `LANGSMITH_TRACING=false` control returned a normal HTTP response and produced zero runs in the
    configured project.

21. **Automated coverage complements the live checks.** `npm run test:server` validates disabled
    tracing, configuration errors, nesting, safe projections, return-value preservation, original
    application errors, and redaction. The standard application suite continues to cover terminal
    logging, routing, scheduling, retrieval, and grounded answers without requiring LangSmith
    network access.

## Reading the output

For a scheduling prompt, the normal order is:

```text
[pipeline] request.start
[pipeline] selector start/success
[routing] SCHEDULE decision and explanation
[pipeline] scheduling start/success
[scheduling] show_confirmation_card, calendarWritePerformed=false
[pipeline] request.complete
```

After the user presses Confirm, a separate request shows:

```text
[pipeline] request.start
[scheduling] submit_confirmed_booking, calendarWritePerformed=true
[pipeline] cal.com start/success or error
[scheduling] booking_created or booking_rejected
[pipeline] request.complete
```

The separation is intentional: merely seeing a scheduling proposal must never imply that an event
was written to Cal.com.

When LangSmith tracing is enabled, the same scheduling request appears as one
`meditaitons.schedule_confirmation` root with a nested `cal.com` span. The `requestId` metadata joins
that trace to the terminal sequence above. In-scope chat appears as a `meditaitons.chat` root with
only the child stages that ran; blocked routes therefore have no embedding or retrieval span.

For route-complete smoke testing, use a unique `X-Request-Id` for each synthetic request and search
for that value in LangSmith metadata. The expected matrix is:

| Route | Root status | Expected children | Forbidden children |
| --- | --- | --- | --- |
| `IN_SCOPE` | success | `selector`, `embedding`, `pinecone`, `grounded_answer` | `scheduling`, `cal.com` |
| `SCHEDULE` | success | `selector`, `scheduling` | `embedding`, `pinecone`, `grounded_answer`, `cal.com` |
| `REFRAME` | success | `selector` | all action and retrieval spans |
| `OUT_OF_SCOPE` | success | `selector` | all action and retrieval spans |
| `NEEDS_CLARIFICATION` | success | `selector` | all action and retrieval spans |
| `SAFETY` | success | `selector` | all action and retrieval spans |

The confirmation POST is checked separately because it is the only request allowed to create a
`cal.com` span or perform a calendar write.
