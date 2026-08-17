import { ROUTING_EVALUATION_CASES } from './edge-cases';
import { OpenAIModerationClient, OpenAIScopeClassifier } from './openai-routing';
import { routeDeterministically, safetyKindFromModeration } from './policy';
import { ConversationRouter } from './router';
import { ModerationGateway, ScopeClassification, ScopeClassifier } from './types';

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
    const router = new ConversationRouter({ moderation, classifier });

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
    const router = new ConversationRouter({ moderation, classifier });

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
    const router = new ConversationRouter({ moderation, classifier });

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

  it('fails closed when moderation or classification is unavailable', async () => {
    const classifier = { classify: vi.fn() } as unknown as ScopeClassifier;
    const moderationFailure = new ConversationRouter({
      moderation: { moderate: vi.fn(async () => Promise.reject(new Error('offline'))) },
      classifier,
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
