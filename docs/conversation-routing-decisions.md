# Meditations conversation routing: implementation decisions

This log records every material policy and engineering decision made for the six-way router. The
router is used by both the terminal query command and the loopback-only API behind the Angular
Journal chatbot. Keys remain server-side.

1. **Exactly six routes are public.** `IN_SCOPE`, `SCHEDULE`, `REFRAME`, `OUT_OF_SCOPE`,
   `NEEDS_CLARIFICATION`, and `SAFETY` make the downstream action auditable. A boolean “allowed”
   would collapse materially different user experiences and make safety behavior harder to test.

2. **Only `IN_SCOPE` permits retrieval.** `retrieve` is derived from the route and is `false` for
   all other routes. This makes the topic boundary structural: a caller cannot accidentally embed
   an out-of-scope, ambiguous, or dangerous prompt just because it received some response text.
   `SCHEDULE` starts a separate proposal flow and never reaches embeddings or Pinecone.

3. **Routing happens before index validation, embedding, or Pinecone querying.** This prevents
   blocked text from leaving through the retrieval path and avoids spending Pinecone or embedding
   resources on prompts that should not be answered from the corpus.

4. **Safety has absolute priority.** The evaluation order is deterministic high-risk rules,
   OpenAI moderation, then semantic scope classification. A safety match returns immediately and
   never calls later stages. An in-scope philosophical theme therefore cannot override concurrent
   self-harm or violence language.

5. **High-signal crisis phrases have a deterministic first pass.** Explicit and ambiguous
   self-harm, violence, abuse, dangerous eating behavior, and reality-distress examples are
   recognized locally. This creates predictable behavior for known cases, lowers latency when
   seconds matter, and makes those cases testable without a network. The rules are deliberately a
   high-signal supplement, not a claim that regular expressions can understand all crises.

6. **Ambiguous danger is routed to `SAFETY`, not retrieval.** “I'm tired of life,” “I want to
   fight someone,” “I want revenge,” and “crash out” receive a direct safety check before any
   philosophy. Asking plainly about immediate danger is safer than assuming figurative intent;
   NIMH specifically notes that asking about suicide does not increase suicidal thoughts or
   behavior: <https://www.nimh.nih.gov/health/publications/5-action-steps-to-help-someone-having-thoughts-of-suicide>.

7. **Crisis messages are fixed application templates.** A classifier selects the safety kind but
   cannot compose the crisis response. This avoids creative variation, philosophical minimization,
   accidental diagnosis, or unsafe instructions. Self-harm templates distinguish ambiguous from
   imminent risk, name U.S. 988 only as a U.S. resource, direct immediate danger to local emergency
   services, and encourage contact with a trusted person. SAMHSA's U.S. crisis guidance supports
   988 and emergency escalation: <https://www.samhsa.gov/find-support/in-crisis>.

8. **Violence messages prioritize distance and immediate de-escalation.** They tell the user not
   to approach the person, to move away from a weapon when safe, and to contact emergency services
   for immediate danger. They never retrieve a passage that could be interpreted as validating
   retaliation.

9. **Abuse is never reframed as endurance.** The response explicitly says the user does not have
   to endure abuse and points toward safety planning and human support. This prevents Stoic themes
   such as endurance or accepting what one cannot control from being applied in a dangerous way.

10. **Medication and other individualized professional instructions are `OUT_OF_SCOPE`.** The
    system does not tell a user to start, stop, or change medication, nor does it replace medical,
    legal, or individualized financial advice. A fixed boundary points to qualified help while
    leaving open a separate Meditations-based reflection.

11. **OpenAI's moderation endpoint is the second safety layer.** It uses
    `omni-moderation-latest` by default and checks the documented self-harm, violent-illicit,
    threatening, and violence categories. Generic violence requires personal action language so a
    corpus question about war is not automatically treated as intent. The official guide and
    category list are here: <https://developers.openai.com/api/docs/guides/moderation#review-supported-categories>.

12. **The semantic router uses the Responses API with Structured Outputs.** A strict JSON Schema
    restricts route, reason, safety kind, and optional reframe fields. The application validates
    route/reason combinations again after parsing; schema adherence is not treated as semantic
    correctness. This follows OpenAI's recommendation to prefer Structured Outputs over JSON mode:
    <https://developers.openai.com/api/docs/guides/structured-outputs>.

13. **The default classifier is `gpt-5.6-luna`, with reasoning effort `none`.** On 2026-08-11 the
    current OpenAI model-selection guidance maps classification, extraction, routing, and
    high-volume simple work to this low-latency model. The model is overrideable through
    `OPENAI_ROUTER_MODEL`; moderation is independently overrideable through
    `OPENAI_MODERATION_MODEL`. Explicit `none` avoids paying the default reasoning cost for a
    bounded classification task.

14. **The classifier prompt defines outcome, priorities, examples, and abstention behavior.** It
    treats the serialized user message as untrusted data, calls prompt-injection attempts
    `OUT_OF_SCOPE`, reserves professional advice, and uses `NEEDS_CLARIFICATION` when intent cannot
    be determined safely. These instructions follow the current GPT-5.6 prompt guidance to state
    success criteria and fail/abstain rules explicitly:
    <https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6>.

15. **OpenAI requests are stateless.** `store: false` is set on the Responses API request. Up to six
    recent user messages can be supplied for conversation-aware routing, but assistant messages are
    excluded so generated text cannot redefine the policy. The terminal command has one user turn;
    the localhost chatbot supplies bounded recent user history.

16. **Routing failures fail closed.** If moderation fails, the result is
    `NEEDS_CLARIFICATION/SAFETY_CHECK_UNAVAILABLE`; if semantic classification fails, it is
    `NEEDS_CLARIFICATION/ROUTER_UNAVAILABLE`. Neither fallback retrieves. This favors a temporary
    non-answer over silently bypassing a safety or scope control.

17. **Input is bounded to 4,000 characters and six history messages.** Empty, overlong, and
    high-confidence nonsense input receives `NEEDS_CLARIFICATION`. The limit constrains latency,
    cost, and prompt-injection surface. History is trimmed from the oldest side, and each retained
    message is independently bounded.

18. **A bare physical need is clarified.** “I'm hungry” could request practical information that
    this corpus cannot provide or could introduce a reflection. It therefore asks which intent the
    user has. “I'm hungry but I don't deserve food” is different and receives the eating-distress
    safety route.

19. **`REFRAME` does not silently search a rewritten prompt.** It returns one bounded reflective
    question and asks the user to choose it explicitly. This prevents a model-generated rewrite
    from becoming an unreviewed retrieval query and keeps the scope transition visible to the
    user.

20. **Questions about the corpus remain `IN_SCOPE` even when the answer may not exist.** “Did
    Marcus say YOLO?” and questions about artificial intelligence are valid requests to check the
    source. Routing is not an evidence judgment. A later answer-generation layer must cite
    retrieved passages and abstain when evidence is insufficient; the current CLI exposes raw
    retrieval instead of inventing an answer.

21. **Unrelated facts, tasks, and prompt injection are rejected without philosophical improvisation.**
    Weather requests, code generation, baking instructions, and attempts to reveal the system
    prompt are outside the data boundary. An emotion caused by an unrelated event can still be
    `IN_SCOPE` because the subject of reflection is the user's judgment rather than the external
    domain.

22. **Multilingual reflective input is allowed.** The semantic classifier is not restricted to
    English. Deterministic English safety rules remain only one layer; moderation and semantic
    classification are required to catch meaning outside those explicit patterns.

23. **The CLI never logs API keys or raw model responses.** Human output includes the prompt the
    user intentionally supplied to the command, the normalized route metadata, fixed route text,
    and allowed retrieval results. The regression suite uses synthetic prompts only.

24. **Tests are split between deterministic unit tests and a live semantic evaluation.** Unit
    tests lock safety priority, no-retrieval invariants, fail-closed behavior, API wire shapes, and
    structured-output validation without cost or nondeterminism. `npm run routing:test` runs all 27
    agreed examples against the configured live moderation and classifier models and exits nonzero
    on any route mismatch.

25. **The router is server-only.** It lives in a reusable TypeScript core module and is used by the
    Node query scripts and localhost chat API. `OPENAI_API_KEY` and Pinecone credentials are never
    added to Angular environment files, API responses, or browser code.

26. **Each remote routing stage has a 20-second total deadline.** The deadline includes retry
    delays, so a stalled moderation or classification request cannot wait indefinitely. Transient
    rate-limit and server errors still receive bounded retries; exhausting the deadline flows into
    the same fail-closed route as any other remote failure.

27. **Scheduling is an explicit action intent, not a philosophical topic.** A request to schedule,
    book, arrange, or set aside a meditation session is `SCHEDULE/MEDITATION_SCHEDULING`. Asking
    when, why, or how often to meditate remains `IN_SCOPE` unless the user asks for a calendar
    action. This keeps retrieval questions and side effects in different branches.

28. **Recent user turns can establish scheduling intent.** The classifier receives bounded recent
    user messages, so “Tuesday at 7” is schedulable after “Please schedule time for meditation.”
    Safety still outranks scheduling, and assistant text cannot establish action intent.
