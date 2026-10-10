import { ROUTING_EVALUATION_CASES } from './edge-cases';
import { OpenAIModerationClient, OpenAIScopeClassifier } from './openai-routing';
import { routeDeterministically, safetyKindFromModeration } from './policy';
import { ConversationRouter } from './router';
import {
  ModerationGateway,
  SafetyFollowUpClassifier,
  ScopeClassification,
  ScopeClassifier,
} from './types';

describe('deterministic conversation routing', () => {
  it('locks the deterministic edge examples to their expected routes', () => {
    const cases = ROUTING_EVALUATION_CASES.filter(
      (testCase) => testCase.expectedSource === 'deterministic',
    );

    for (const testCase of cases) {
      const decision = routeDeterministically({ message: testCase.prompt });
      expect(decision, testCase.id).toMatchObject({
        route: testCase.expectedRoute,
        source: 'deterministic',
        retrieve: false,
      });
    }
  });

  it('does not confuse fear of death with self-harm intent', () => {
    expect(routeDeterministically({ message: "I'm afraid of dying." })).toBeUndefined();
  });

  it('requires personal action language before generic moderated violence becomes safety', () => {
    const categories = { violence: true };
    expect(safetyKindFromModeration('What did Marcus say about war?', categories)).toBeUndefined();
    expect(safetyKindFromModeration('I want to attack them.', categories)).toBe(
      'VIOLENCE_AMBIGUOUS',
    );
  });
});

describe('conversation router orchestration', () => {
  it('lets deterministic safety bypass both remote services', async () => {
    const moderation = { moderate: vi.fn() } as unknown as ModerationGateway;
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const router = new ConversationRouter({
      moderation,
      classifier,
      safetyFollowUp: unusedSafetyFollowUp(),
    });

    await expect(router.route({ message: 'I want to fight someone.' })).resolves.toMatchObject({
      route: 'SAFETY',
      retrieve: false,
      safetyKind: 'VIOLENCE_AMBIGUOUS',
    });
    expect(moderation.moderate).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('lets a moderation safety result bypass the scope classifier', async () => {
    const moderation: ModerationGateway = {
      moderate: vi.fn(async () => ({
        flagged: true,
        categories: { 'self-harm/intent': true },
      })),
    };
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const router = new ConversationRouter({
      moderation,
      classifier,
      safetyFollowUp: unusedSafetyFollowUp(),
    });

    await expect(router.route({ message: 'I no longer want to exist.' })).resolves.toMatchObject({
      route: 'SAFETY',
      source: 'moderation',
      retrieve: false,
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('allows retrieval only for a classifier IN_SCOPE result', async () => {
    const moderation: ModerationGateway = {
      moderate: vi.fn(async () => ({ flagged: false, categories: {} })),
    };
    const classifier: ScopeClassifier = {
      classify: vi.fn(async (): Promise<ScopeClassification> => ({
        route: 'IN_SCOPE',
        reason: 'PERSONAL_REFLECTION',
        safetyKind: null,
        suggestedReflection: null,
      })),
    };
    const router = new ConversationRouter({
      moderation,
      classifier,
      safetyFollowUp: unusedSafetyFollowUp(),
    });

    await expect(router.route({ message: "I'm happy." })).resolves.toMatchObject({
      route: 'IN_SCOPE',
      retrieve: true,
      source: 'classifier',
    });
  });

  it('routes scheduling as a non-retrieval action', async () => {
    const classifier: ScopeClassifier = {
      classify: vi.fn(async (): Promise<ScopeClassification> => ({
        route: 'SCHEDULE',
        reason: 'MEDITATION_SCHEDULING',
        safetyKind: null,
        suggestedReflection: null,
      })),
    };
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier,
      safetyFollowUp: unusedSafetyFollowUp(),
    });

    await expect(
      router.route({
        message: 'Tuesday at 7.',
        recentUserMessages: ['Please schedule time for me to meditate.'],
      }),
    ).resolves.toMatchObject({
      route: 'SCHEDULE',
      reason: 'MEDITATION_SCHEDULING',
      retrieve: false,
    });
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        recentUserMessages: ['Please schedule time for me to meditate.'],
      }),
    );
  });

  it('keeps vague reassurance in a fixed safety follow-up', async () => {
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const safetyFollowUp: SafetyFollowUpClassifier = {
      assessSafetyFollowUp: vi.fn(
        async () =>
          ({
            status: 'FOLLOW_UP_REQUIRED',
            safetyKind: 'VIOLENCE_AMBIGUOUS',
            continuationMessage: null,
            deferredSafetyTopic: null,
          }) as const,
      ),
    };
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier,
      safetyFollowUp,
    });

    await expect(
      router.route({
        message: "I'm okay now.",
        pendingSafety: { kind: 'VIOLENCE_AMBIGUOUS' },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      reason: 'SAFETY_FOLLOW_UP_REQUIRED',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      safetyFollowUpStatus: 'FOLLOW_UP_REQUIRED',
      retrieve: false,
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('acknowledges a deferred topic while keeping the fixed safety question', async () => {
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'FOLLOW_UP_REQUIRED',
              safetyKind: 'VIOLENCE_IMMINENT',
              continuationMessage: null,
              deferredSafetyTopic,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message: deferredSafetyTopic.message,
        pendingSafety: { kind: 'VIOLENCE_IMMINENT' },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'VIOLENCE_IMMINENT',
      deferredSafetyTopic,
      userMessage: expect.stringMatching(
        /^Before we talk about your concerns about AI and job security, I need to make sure everyone is safe\./u,
      ),
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('preserves but does not mention a deferred topic while danger is active', async () => {
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier: { classify: vi.fn() } as unknown as ScopeClassifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'ACTIVE',
              safetyKind: 'VIOLENCE_IMMINENT',
              continuationMessage: null,
              deferredSafetyTopic: null,
            }) as const,
        ),
      },
    });

    const decision = await router.route({
      message: "I'm safe, but I still might do it.",
      pendingSafety: { kind: 'VIOLENCE_IMMINENT', deferredSafetyTopic },
    });

    expect(decision).toMatchObject({
      route: 'SAFETY',
      safetyFollowUpStatus: 'ACTIVE',
      deferredSafetyTopic,
    });
    expect(decision.userMessage).not.toContain('AI and job security');
  });

  it('re-moderates and resumes a stored deferred topic after safety resolves', async () => {
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    const moderation = vi.fn(async () => ({ flagged: false, categories: {} }));
    const classifier: ScopeClassifier = {
      classify: vi.fn(async (): Promise<ScopeClassification> => ({
        route: 'IN_SCOPE',
        reason: 'PERSONAL_REFLECTION',
        safetyKind: null,
        suggestedReflection: null,
      })),
    };
    const router = new ConversationRouter({
      moderation: { moderate: moderation },
      classifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'RESOLVED',
              safetyKind: 'VIOLENCE_IMMINENT',
              continuationMessage: null,
              deferredSafetyTopic: null,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message:
          "I'm not going to hurt anyone, the plan is off, I put the object down, and I left the area.",
        pendingSafety: { kind: 'VIOLENCE_IMMINENT', deferredSafetyTopic },
      }),
    ).resolves.toMatchObject({
      route: 'IN_SCOPE',
      effectiveMessage: deferredSafetyTopic.message,
      resumedDeferredSafetyTopic: deferredSafetyTopic,
      safetyFollowUpStatus: 'RESOLVED',
    });
    expect(moderation).toHaveBeenNthCalledWith(2, deferredSafetyTopic.message);
    expect(classifier.classify).toHaveBeenCalledWith({
      message: deferredSafetyTopic.message,
      recentUserMessages: [],
    });
  });

  it('routes a stored deferred topic back to safety when fresh moderation flags it', async () => {
    const deferredSafetyTopic = {
      label: 'your thoughts about whether life is worth continuing',
      message: 'I have been considering whether life is worth continuing.',
    } as const;
    const moderation = vi
      .fn()
      .mockResolvedValueOnce({ flagged: false, categories: {} })
      .mockResolvedValueOnce({ flagged: true, categories: { 'self-harm': true } });
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const router = new ConversationRouter({
      moderation: { moderate: moderation },
      classifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'RESOLVED',
              safetyKind: 'VIOLENCE_IMMINENT',
              continuationMessage: null,
              deferredSafetyTopic: null,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message:
          "I'm not going to hurt anyone, the plan is off, I put the object down, and I left the area.",
        pendingSafety: { kind: 'VIOLENCE_IMMINENT', deferredSafetyTopic },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'SELF_HARM_AMBIGUOUS',
      source: 'moderation',
    });
    expect(moderation).toHaveBeenNthCalledWith(2, deferredSafetyTopic.message);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('replaces an older deferred topic with the newest valid follow-up topic', async () => {
    const olderTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    const newerTopic = {
      label: 'your conflict with your manager',
      message: 'Can we talk about the conflict with my manager instead?',
    } as const;
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier: { classify: vi.fn() } as unknown as ScopeClassifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'FOLLOW_UP_REQUIRED',
              safetyKind: 'VIOLENCE_IMMINENT',
              continuationMessage: null,
              deferredSafetyTopic: newerTopic,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message: newerTopic.message,
        pendingSafety: { kind: 'VIOLENCE_IMMINENT', deferredSafetyTopic: olderTopic },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      deferredSafetyTopic: newerTopic,
      userMessage: expect.stringContaining(newerTopic.label),
    });
  });

  it('uses an exact resolved continuation for normal routing despite a moderation signal', async () => {
    const classifier: ScopeClassifier = {
      classify: vi.fn(async (): Promise<ScopeClassification> => ({
        route: 'IN_SCOPE',
        reason: 'PERSONAL_REFLECTION',
        safetyKind: null,
        suggestedReflection: null,
      })),
    };
    const safetyFollowUp: SafetyFollowUpClassifier = {
      assessSafetyFollowUp: vi.fn(
        async () =>
          ({
            status: 'RESOLVED',
            safetyKind: 'VIOLENCE_AMBIGUOUS',
            continuationMessage: 'Help me reflect on my anger.',
            deferredSafetyTopic: null,
          }) as const,
      ),
    };
    const router = new ConversationRouter({
      moderation: {
        moderate: vi.fn(async () => ({ flagged: true, categories: { violence: true } })),
      },
      classifier,
      safetyFollowUp,
    });
    const message = "I'm not thinking about hurting anyone now. Help me reflect on my anger.";

    const decision = await router.route({
      message,
      pendingSafety: {
        kind: 'VIOLENCE_AMBIGUOUS',
        deferredSafetyTopic: {
          label: 'your earlier work concern',
          message: 'Help me reflect on work.',
        },
      },
    });
    expect(decision).toMatchObject({
      route: 'IN_SCOPE',
      retrieve: true,
      effectiveMessage: 'Help me reflect on my anger.',
      safetyFollowUpStatus: 'RESOLVED',
    });
    expect(decision).not.toHaveProperty('resumedDeferredSafetyTopic');
    expect(safetyFollowUp.assessSafetyFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        message,
        moderatedSafetyKind: 'VIOLENCE_AMBIGUOUS',
      }),
    );
    expect(classifier.classify).toHaveBeenCalledWith({
      message: 'Help me reflect on my anger.',
      recentUserMessages: [],
    });
  });

  it('does not downgrade an imminent concern while asking for follow-up', async () => {
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier: { classify: vi.fn() } as unknown as ScopeClassifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'FOLLOW_UP_REQUIRED',
              safetyKind: 'VIOLENCE_AMBIGUOUS',
              continuationMessage: null,
              deferredSafetyTopic: null,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message: "I won't do it.",
        pendingSafety: { kind: 'VIOLENCE_IMMINENT' },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'VIOLENCE_IMMINENT',
    });
  });

  it('resolves without retrieval when no separate continuation is present', async () => {
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(
          async () =>
            ({
              status: 'RESOLVED',
              safetyKind: 'VIOLENCE_AMBIGUOUS',
              continuationMessage: null,
              deferredSafetyTopic: null,
            }) as const,
        ),
      },
    });

    await expect(
      router.route({
        message: 'I am not thinking about hurting anyone right now.',
        pendingSafety: { kind: 'VIOLENCE_AMBIGUOUS' },
      }),
    ).resolves.toMatchObject({
      route: 'NEEDS_CLARIFICATION',
      reason: 'SAFETY_RESOLVED',
      safetyFollowUpStatus: 'RESOLVED',
      retrieve: false,
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('lets a fresh deterministic threat override pending follow-up assessment', async () => {
    const safetyFollowUp = unusedSafetyFollowUp();
    const moderation = { moderate: vi.fn() } as unknown as ModerationGateway;
    const router = new ConversationRouter({
      moderation,
      classifier: { classify: vi.fn() } as unknown as ScopeClassifier,
      safetyFollowUp,
    });

    await expect(
      router.route({
        message: "I'm going to kill myself tonight.",
        pendingSafety: { kind: 'VIOLENCE_AMBIGUOUS' },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'SELF_HARM_IMMINENT',
      source: 'deterministic',
    });
    expect(moderation.moderate).not.toHaveBeenCalled();
    expect(safetyFollowUp.assessSafetyFollowUp).not.toHaveBeenCalled();
  });

  it('fails closed in SAFETY when follow-up reassessment is unavailable', async () => {
    const router = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier: { classify: vi.fn() } as unknown as ScopeClassifier,
      safetyFollowUp: {
        assessSafetyFollowUp: vi.fn(async () => Promise.reject(new Error('offline'))),
      },
    });

    await expect(
      router.route({
        message: 'I am not going to hurt anyone.',
        pendingSafety: { kind: 'VIOLENCE_AMBIGUOUS' },
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      reason: 'SAFETY_REASSESSMENT_UNAVAILABLE',
      retrieve: false,
    });
  });

  it('fails closed when moderation or classification is unavailable', async () => {
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const moderationFailure = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => Promise.reject(new Error('offline'))) },
      classifier,
      safetyFollowUp: unusedSafetyFollowUp(),
    });
    await expect(moderationFailure.route({ message: "I'm calm." })).resolves.toMatchObject({
      route: 'NEEDS_CLARIFICATION',
      reason: 'SAFETY_CHECK_UNAVAILABLE',
      retrieve: false,
    });
    expect(classifier.classify).not.toHaveBeenCalled();

    const classifierFailure = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => ({ flagged: false, categories: {} })) },
      classifier: { classify: vi.fn(async () => Promise.reject(new Error('offline'))) },
      safetyFollowUp: unusedSafetyFollowUp(),
    });
    await expect(classifierFailure.route({ message: "I'm calm." })).resolves.toMatchObject({
      route: 'NEEDS_CLARIFICATION',
      reason: 'ROUTER_UNAVAILABLE',
      retrieve: false,
    });
  });
});

describe('OpenAI routing clients', () => {
  it('sends moderation input with the supported moderation model', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'modr-test',
        model: 'omni-moderation-latest',
        results: [{ flagged: true, categories: { violence: true } }],
      }),
    );
    const client = new OpenAIModerationClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(client.moderate('I will attack them.')).resolves.toEqual({
      flagged: true,
      categories: { violence: true },
    });
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/moderations');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'omni-moderation-latest',
      input: 'I will attack them.',
    });
  });

  it('uses a strict Responses API schema and parses its output text', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  route: 'REFRAME',
                  reason: 'REFLECTIVE_REFRAME',
                  safety_kind: null,
                  suggested_reflection: 'What desire is shaping my judgment?',
                }),
              },
            ],
          },
        ],
      }),
    );
    const client = new OpenAIScopeClassifier({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(client.classify({ message: 'Which stock should I buy?' })).resolves.toEqual({
      route: 'REFRAME',
      reason: 'REFLECTIVE_REFRAME',
      safetyKind: null,
      suggestedReflection: 'What desire is shaping my judgment?',
    });
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning: { effort: 'none' },
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'meditations_conversation_route',
          strict: true,
        },
      },
    });
    expect(body.text.format.schema.additionalProperties).toBe(false);
  });

  it('uses structured output for safety follow-up and validates an exact continuation', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  status: 'RESOLVED',
                  safety_kind: 'VIOLENCE_AMBIGUOUS',
                  continuation_message: 'Help me reflect on my anger.',
                  deferred_topic_label: null,
                  deferred_message: null,
                }),
              },
            ],
          },
        ],
      }),
    );
    const client = new OpenAIScopeClassifier({ apiKey: 'test-key', fetchImplementation });
    const message = "I'm not thinking about hurting anyone now. Help me reflect on my anger.";

    await expect(
      client.assessSafetyFollowUp({
        message,
        recentUserMessages: ['I might hurt my neighbor.'],
        priorSafetyKind: 'VIOLENCE_AMBIGUOUS',
        moderatedSafetyKind: 'VIOLENCE_AMBIGUOUS',
      }),
    ).resolves.toEqual({
      status: 'RESOLVED',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      continuationMessage: 'Help me reflect on my anger.',
      deferredSafetyTopic: null,
    });
    const [, init] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'meditations_safety_follow_up',
      strict: true,
    });
    expect(JSON.parse(body.input)).toMatchObject({
      prior_safety_kind: 'VIOLENCE_AMBIGUOUS',
      moderation_safety_kind: 'VIOLENCE_AMBIGUOUS',
      current_message: message,
    });
  });

  it('extracts a validated deferred topic from structured safety output', async () => {
    const message = 'Can we talk about my fear of AI replacing me at work?';
    const client = new OpenAIScopeClassifier({
      apiKey: 'test-key',
      fetchImplementation: async () =>
        jsonResponse({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    status: 'FOLLOW_UP_REQUIRED',
                    safety_kind: 'VIOLENCE_IMMINENT',
                    continuation_message: null,
                    deferred_topic_label: 'your concerns about AI and job security',
                    deferred_message: message,
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(
      client.assessSafetyFollowUp({
        message,
        recentUserMessages: [],
        priorSafetyKind: 'VIOLENCE_IMMINENT',
        moderatedSafetyKind: null,
      }),
    ).resolves.toMatchObject({
      status: 'FOLLOW_UP_REQUIRED',
      deferredSafetyTopic: {
        label: 'your concerns about AI and job security',
        message,
      },
    });
  });

  it('discards invalid personalization without discarding the safety assessment', async () => {
    const message = 'Tell me about AI.';
    const client = new OpenAIScopeClassifier({
      apiKey: 'test-key',
      fetchImplementation: async () =>
        jsonResponse({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    status: 'FOLLOW_UP_REQUIRED',
                    safety_kind: 'VIOLENCE_AMBIGUOUS',
                    continuation_message: null,
                    deferred_topic_label: 'your <script>instructions</script>',
                    deferred_message: message,
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(
      client.assessSafetyFollowUp({
        message,
        recentUserMessages: [],
        priorSafetyKind: 'VIOLENCE_AMBIGUOUS',
        moderatedSafetyKind: null,
      }),
    ).resolves.toMatchObject({
      status: 'FOLLOW_UP_REQUIRED',
      deferredSafetyTopic: null,
    });
  });

  it('rejects inconsistent structured classifier output', async () => {
    const client = new OpenAIScopeClassifier({
      apiKey: 'test-key',
      fetchImplementation: async () =>
        jsonResponse({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    route: 'IN_SCOPE',
                    reason: 'EXTERNAL_FACT',
                    safety_kind: null,
                    suggested_reflection: null,
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(client.classify({ message: 'Weather?' })).rejects.toThrowError(
      /inconsistent route and reason/,
    );
  });

  it('accepts a structured scheduling action', async () => {
    const client = new OpenAIScopeClassifier({
      apiKey: 'test-key',
      fetchImplementation: async () =>
        jsonResponse({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    route: 'SCHEDULE',
                    reason: 'MEDITATION_SCHEDULING',
                    safety_kind: null,
                    suggested_reflection: null,
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(client.classify({ message: 'Schedule meditation Tuesday.' })).resolves.toEqual({
      route: 'SCHEDULE',
      reason: 'MEDITATION_SCHEDULING',
      safetyKind: null,
      suggestedReflection: null,
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unusedSafetyFollowUp(): SafetyFollowUpClassifier {
  return {
    assessSafetyFollowUp: vi.fn(async () => {
      throw new Error('safety follow-up was not expected');
    }),
  };
}
