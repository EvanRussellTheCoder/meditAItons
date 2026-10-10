# Meditations conversation routing: implementation decisions

This log records every material policy and engineering decision made for the six-way router. The
router is used by both the terminal query command and the loopback-only API behind the Angular
Journal chatbot. Keys remain server-side.

## Safety follow-up lifecycle at a glance

Only self-harm and violence use the sticky follow-up lifecycle. The most recent assistant
`SAFETY` entry carries the pending `safetyKind` and, when present, one validated
`deferredSafetyTopic`. The next user message is assessed as:

| Status               | Meaning                                                                                                                         | Application behavior                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ACTIVE`             | Current intent, an underway action or plan, continuing access/proximity, inability to remain safe, or contradictory reassurance | Return the existing fixed crisis response; retain but do not mention a saved topic.                                |
| `FOLLOW_UP_REQUIRED` | The answer is vague, incomplete, or changes the subject                                                                         | Optionally acknowledge a validated topic label, then ask the unchanged fixed safety question.                      |
| `RESOLVED`           | The required present-tense denial and, for imminent cases, action/access/proximity conditions are explicit                      | Route a new exact continuation, otherwise recheck and resume the stored topic, otherwise ask what to discuss next. |

Resolution and resumption are separate decisions. `RESOLVED` closes the pending check; it does not
pre-authorize the postponed text. Stored text must pass current deterministic and moderation checks
and normal classification before any downstream capability runs.

The structured assessment returns five required fields: `status`, `safety_kind`,
`continuation_message`, `deferred_topic_label`, and `deferred_message`. The two deferred fields are
permitted only for `FOLLOW_UP_REQUIRED` and must appear together. Invalid optional personalization
is discarded without weakening a valid safety status; invalid status, safety kind, or continuation
fails closed.

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

4. **Current or unresolved safety has absolute priority.** The evaluation order is deterministic
   high-risk rules, OpenAI moderation, an explicit pending-safety reassessment when needed, then
   semantic scope classification. An in-scope philosophical theme cannot override concurrent or
   unresolved self-harm or violence language, but resolved historical language does not permanently
   dominate later turns.

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
    recent user messages can be supplied for conversation-aware routing. Assistant text is excluded
    so generated prose cannot redefine the policy; validated assistant route and safety-kind metadata
    may establish whether a safety follow-up is pending. The terminal command has one user turn; the
    localhost chatbot supplies bounded recent history.

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
    structured-output validation without cost or nondeterminism. `npm run routing:test` runs 27
    single-turn and nine multi-turn safety cases against the configured live moderation and
    classifier models and exits nonzero on any route mismatch.

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

29. **Intent safety has an explicit resolution lifecycle.** Self-harm and violence concerns remain
    pending while the latest routed assistant response is `SAFETY`; a legacy response without kind
    metadata receives one conservative generic reassessment. A structured reassessment returns
    `ACTIVE`, `FOLLOW_UP_REQUIRED`, or `RESOLVED`. Abuse, eating-disorder, reality-distress, and
    other safety responses remain serious but do not automatically make the following safe topic a
    safety follow-up.

30. **Vague reassurance does not clear a concern.** Ambiguous danger requires an explicit denial of
    current intent. Imminent danger additionally requires the user to say that the plan or action is
    not underway and that relevant access or proximity has ended. Contradictory language remains
    active, and reassessment failures remain on `SAFETY` without retrieval.

31. **Moderation is a signal during follow-up, not an automatic lock.** Negated phrases such as “I
    am not going to hurt anyone” can contain words that trigger deterministic or moderation rules.
    During a pending exchange, explicit negations are interpreted by the dedicated reassessment while
    fresh unnegated deterministic threats still return immediately.

32. **Same-turn continuation is exact and bounded.** A resolved reassessment may select a new safe
    request only by copying an exact contiguous substring of the current message. That substring,
    rather than the safety denial, is classified and sent to scheduling, embedding, retrieval, or
    answer generation. Invalid extraction fails closed.

33. **Browser history carries validated routing metadata.** Assistant history entries may include
    `route` and `safetyKind`; user entries may not. The API response always includes nullable
    `safetyKind`, existing stored conversations without it receive one conservative generic
    reassessment, and completed safety segments are excluded from later classifier context.

34. **A postponed topic can be acknowledged without weakening the safety check.** Only a
    `FOLLOW_UP_REQUIRED` reassessment may return a neutral, validated label beginning with “your”
    and an exact substring copied from the current user message. The application combines that label
    with fixed self-harm or violence wording; `ACTIVE` responses never display the topic label.

35. **Deferred content is state, not permission to bypass routing.** A valid postponed topic is
    stored only on an assistant `SAFETY` entry with an intent-based safety kind. After resolution,
    the exact stored message is checked again by deterministic rules and moderation before normal
    classification. No retrieval, generation, or scheduling occurs while the concern is unresolved.

36. **Resumption follows explicit precedence.** A safe exact continuation in the resolution turn
    wins over a previously deferred topic. Otherwise the stored topic resumes automatically; if
    neither exists, the app asks what the user would like to reflect on. A newer valid postponed
    topic replaces an older one, while reassessment failures preserve the stored topic for retry.

37. **Personalization is presentation-only.** `deferred_topic_label` is normalized to one line,
    limited to 100 characters, required to begin with “your,” and rejected when it contains control
    characters, markup-like delimiters, or a question/exclamation ending. It is never used for
    routing, retrieval, scheduling, or generation. Only the exact `deferred_message` can become the
    effective downstream request.

38. **Safety-state observability is structural by default.** Routing logs and LangSmith selector
    spans record the prior kind, follow-up status, resolution/resumption transition, topic presence,
    label/message lengths, and effective-message length. Topic content remains subject to the
    existing synthetic-only LangSmith content-capture flag.
