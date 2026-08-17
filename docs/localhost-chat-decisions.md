# Localhost Angular chatbot: implementation decisions

This log records the material decisions made while replacing the Journal's simulated replies with
the real routing, Pinecone retrieval, and grounded-answer pipeline.

1. **The browser calls a local backend rather than OpenAI or Pinecone directly.** Angular posts to
   same-origin `/api/chat`; the development proxy forwards that path to Node on port 3000. This
   keeps `OPENAI_API_KEY`, `PINECONE_API_KEY`, the index host, and all provider authorization
   headers out of JavaScript shipped to the browser.

2. **`npm start` launches both required processes.** A small Node supervisor starts the Angular
   development server and the API watch process, forwards their output, and terminates the sibling
   process if either exits. Separate `npm run start:web`, `npm run start:api`, and non-watch
   `npm run chat:api` commands remain available for diagnosis.

3. **The API binds to loopback only.** Its default address is `127.0.0.1:3000`, and configuration
   rejects non-loopback hosts. This is a local development service with no authentication and must
   not accidentally become a network-accessible production endpoint.

4. **Browser origins are restricted.** `/api/chat` and `/api/schedule` accept a missing Origin for local tools and the
   two Angular development origins (`localhost:4200` and `127.0.0.1:4200`). Other origins receive 403. The service does not enable CORS because Angular uses a same-origin proxy.

5. **The server validates and bounds the complete request.** Current messages are limited to the
   composer's 600 characters. History is limited to eight messages, each at most 2,400 characters,
   and the entire JSON body to 32 KiB. Unknown shapes, invalid authors, non-JSON bodies, wrong
   content types, and oversized payloads fail before any provider call.

6. **Conversation history is deliberately small and stateless.** The browser sends the eight most
   recent displayed messages. The router sees only recent user messages; the answer model sees the
   bounded user and assistant context for follow-up meaning. OpenAI requests set `store: false`, and
   no conversation is written to `DATABASE_URL` or another server database.

7. **The six-way router remains the only retrieval gate.** The API calls the existing router
   before constructing an embedding or Pinecone client request. `REFRAME`, `OUT_OF_SCOPE`,
   `NEEDS_CLARIFICATION`, `SCHEDULE`, and `SAFETY` return their bounded route response with an empty citation
   list. Only `IN_SCOPE` continues.

8. **Pinecone configuration is preflighted when the API starts.** Startup requires the configured
   index to be a ready, standard, dense 1536-dimensional index. A bad index configuration prevents
   the server from announcing readiness instead of failing only after the first user message.

9. **Retrieval uses five children and at most four unique parents.** Five results provide some
   semantic breadth. Results are deduplicated by `parent_id` because overlapping children from one
   section should not crowd out other evidence. Generation receives the complete canonical
   `parent_text`, not only the matching child, preserving the parent/child design.

10. **Retrieved vectors must match the configured embedding contract.** Every match must report the
    expected `embedding_model` and 1536 dimensions. Missing parent IDs, references, parent text,
    child text, or source URLs abort generation rather than letting incomplete provenance reach the
    model.

11. **Only George Long Wikisource URLs become clickable citations.** The backend and frontend both
    require HTTPS, the exact `en.wikisource.org` hostname, and a `/wiki/` path. This defense in depth
    prevents compromised or malformed metadata from turning into an arbitrary link in the Journal.

12. **The answer model is role-specific.** Routing keeps the low-latency `gpt-5.6-luna`; grounded
    user-facing prose defaults to `gpt-5.6-sol` with low reasoning. This preserves the tiered design
    recommended by current OpenAI model guidance instead of using the flagship for every request.
    `OPENAI_CHAT_MODEL` can override the answer model without changing the router.

13. **Grounded generation uses the Responses API and a strict output schema.** The response must
    contain `sufficient_evidence`, `answer`, and `cited_references`. The schema's citation enum is
    built from the references in that request, and application validation again rejects any
    unsupplied reference. This follows OpenAI's Structured Outputs guidance:
    <https://developers.openai.com/api/docs/guides/structured-outputs>.

14. **The prompt makes grounding and abstention explicit.** It states the outcome, evidence limit,
    citation requirement, safety boundary, response length, and stop rule. It now tells the model to
    keep its own prose paraphrased because the application renders exact quotations separately.
    User messages and history are labeled untrusted data. This follows the current GPT-5.6 guidance
    to use outcome-first prompts with explicit evidence and stopping conditions:
    <https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6>.

15. **Insufficient evidence produces a fixed application abstention.** The model may judge that
    retrieved parents do not address the question, but its unsupported draft is not shown. The
    server returns a fixed statement that this edition did not support a reliable answer and emits
    no citation. This prevents a semantically in-scope question, such as Marcus's view of artificial
    intelligence, from becoming permission to invent an answer.

16. **Every selected citation includes its exact retrieved child passage.** The backend copies
    `chunk_text` from the Pinecone match; it does not ask the answer model to generate or transcribe
    a quotation. Before generation, it requires that child text to be an exact substring of the
    canonical `parent_text`. This preserves the parent for reasoning while making the shorter child
    safe to present as verbatim evidence.

17. **Quoted passages are separate semantic UI elements.** The answer may name `Meditations 8.36`
    inline, while the message component renders each exact passage inside `blockquote` and `em`
    elements, followed by a focusable Wikisource link. Italics therefore mean “verbatim passage
    retrieved from this edition,” not “an objectively true philosophical claim.” Links open in a
    new tab with `noopener noreferrer` and preserve the existing visual system.

18. **The browser validates server responses before storing them.** Route, reason, message, citation
    shape, canonical reference, non-empty bounded quote, and URL are checked at runtime.
    Non-`IN_SCOPE` responses containing citations are rejected. TypeScript interfaces alone are not
    treated as a trust boundary.

19. **Network failures are visible but bounded.** The Journal clears its typing state and appends a
    fixed local-service error without exposing provider errors, keys, response bodies, or stack
    traces. The server logs a whitespace-normalized, length-limited diagnostic and sends a generic
    500 response.

20. **Reset invalidates in-flight replies.** Each send gets a local request generation number.
    Reset increments it, so a slow earlier response cannot reappear in the newly reset conversation.
    The composer remains disabled while one request is active, preventing accidental parallel sends.

21. **The local API has basic resource controls.** It accepts at most six concurrent chat requests,
    returns 429 with `Retry-After` when busy, sends `Cache-Control: no-store`, and never mutates
    Pinecone. These are development safeguards, not a substitute for production authentication,
    per-user quotas, telemetry, or deployment hardening.

22. **Tests cover both sides of the boundary.** Angular tests verify the HTTP request, runtime
    response validation, state transitions, exact quote propagation and markup, connection failure,
    and reset race. Backend tests prove blocked routes make zero retrieval/generation calls,
    successful answers map only selected retrieved citations, altered child text is rejected,
    insufficient evidence abstains, startup preflights the index, and GPT-5.6 uses the intended
    strict request contract. A live browser check confirmed the returned passage appears in an
    italic semantic blockquote with the expected Wikisource destination and no browser errors.

23. **The simulated starter exchange was retired.** New and migrated localhost sessions begin only
    with “What troubles your mind today?” The local-storage key first moved from v1 to v2 so saved
    mock replies could not be replayed into the live model. It moved to v3 when exact quotes became
    required, preventing older stored citation objects without quote text from entering the new UI.

24. **Calendar writes have a separate confirmation endpoint.** `/api/chat` can return a proposal,
    but only `/api/schedule` can call Cal.com. The Angular confirmation card collects editable
    date, time, IANA timezone, attendee name, and attendee email. This makes the external action and
    its exact parameters visible before consent.

25. **Calendar booking state cannot be hidden while a request is active.** The composer, cancel
    control, and clear-conversation control are disabled during the booking POST. A completed or
    uncertain external action therefore cannot disappear behind a concurrent local state change.

26. **Terminal output uses correlated pipeline and decision logs.** The API returns `X-Request-Id`
    and uses it for selector, retrieval, scheduling, and Cal.com stage timings. Pretty routing and
    scheduling summaries explain the selected branches, while error logs omit exception messages,
    credentials, attendee identity, and raw provider responses.
