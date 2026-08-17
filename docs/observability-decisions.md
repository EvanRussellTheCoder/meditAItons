# Terminal observability: implementation decisions

This log records the decisions behind the local API's terminal output. The format intentionally
resembles the Parsity medical RAG application's observability: compact pipeline events for machines
and readable decision summaries for people.

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
