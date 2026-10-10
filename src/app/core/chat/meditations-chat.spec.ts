import type { ChatApiRequest, MeditationScheduleProposal } from '../models/chat.models';
import type { PineconeQueryMatch } from '../pinecone';
import type { RoutingDecision } from '../routing';
import { OpenAIGroundedAnswerClient } from './openai-grounded-answer';
import { MeditationsChatService } from './meditations-chat';

describe('MeditationsChatService', () => {
  it('returns a blocked route without embedding, Pinecone, or answer generation', async () => {
    const dependencies = fakeDependencies();
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        route: 'OUT_OF_SCOPE',
        reason: 'EXTERNAL_TASK',
        retrieve: false,
        userMessage: 'That request is outside this conversation.',
      }),
    );
    const service = new MeditationsChatService(dependencies);

    await expect(service.respond(request('Write Python code.'))).resolves.toEqual({
      route: 'OUT_OF_SCOPE',
      reason: 'EXTERNAL_TASK',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'That request is outside this conversation.',
      citations: [],
      schedulingProposal: null,
    });
    expect(dependencies.embeddings.createEmbeddings).not.toHaveBeenCalled();
    expect(dependencies.pinecone.queryByVector).not.toHaveBeenCalled();
    expect(dependencies.answers.generate).not.toHaveBeenCalled();
  });

  it('retrieves, generates, and maps only model-selected references to trusted citations', async () => {
    const dependencies = fakeDependencies();
    const service = new MeditationsChatService(dependencies);

    await expect(service.respond(request("I'm anxious about tomorrow."))).resolves.toEqual({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'Attend to what is present. Meditations 8.36',
      citations: [
        {
          canonicalRef: '8.36',
          quote: 'Do not disturb thyself by thinking of the whole of thy life.',
          sourceUrl: 'https://en.wikisource.org/wiki/Meditations/Book_VIII',
        },
      ],
      schedulingProposal: null,
    });
    expect(dependencies.embeddings.createEmbeddings).toHaveBeenCalledWith([
      "I'm anxious about tomorrow.",
    ]);
    expect(dependencies.pinecone.queryByVector).toHaveBeenCalledWith('long-1862', [0.1, 0.2], 5);
    expect(dependencies.answers.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: [
          expect.objectContaining({
            canonicalRef: '8.36',
            parentText: expect.stringContaining('whole of thy life'),
            quoteText: 'Do not disturb thyself by thinking of the whole of thy life.',
          }),
        ],
      }),
    );
  });

  it('creates a confirmation proposal for SCHEDULE without retrieval or a calendar write', async () => {
    const dependencies = fakeDependencies();
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        route: 'SCHEDULE',
        reason: 'MEDITATION_SCHEDULING',
        retrieve: false,
        userMessage: 'Review the proposed meditation time.',
      }),
    );
    dependencies.scheduling.propose.mockResolvedValue({
      message: 'Review the proposed meditation time.',
      proposal: {
        proposalId: 'proposal-1',
        suggestedDate: '2026-08-18',
        suggestedTime: '19:00',
        timezone: 'America/New_York',
        durationMinutes: 30,
      },
    });

    await expect(
      new MeditationsChatService(dependencies).respond(request('Schedule meditation Tuesday.')),
    ).resolves.toMatchObject({
      route: 'SCHEDULE',
      reason: 'MEDITATION_SCHEDULING',
      citations: [],
      schedulingProposal: { proposalId: 'proposal-1' },
    });
    expect(dependencies.scheduling.propose).toHaveBeenCalledWith({
      message: 'Schedule meditation Tuesday.',
      history: [{ author: 'marcus', content: 'What troubles your mind today?' }],
      timezone: 'America/New_York',
    });
    expect(dependencies.embeddings.createEmbeddings).not.toHaveBeenCalled();
    expect(dependencies.pinecone.queryByVector).not.toHaveBeenCalled();
    expect(dependencies.answers.generate).not.toHaveBeenCalled();
  });

  it('restores an unresolved violence concern from assistant routing metadata', async () => {
    const dependencies = fakeDependencies();
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        route: 'SAFETY',
        reason: 'SAFETY_FOLLOW_UP_REQUIRED',
        retrieve: false,
        safetyKind: 'VIOLENCE_AMBIGUOUS',
        safetyFollowUpStatus: 'FOLLOW_UP_REQUIRED',
        deferredSafetyTopic,
        userMessage: 'Are you thinking about hurting anyone right now?',
      }),
    );
    const service = new MeditationsChatService(dependencies);

    await expect(
      service.respond({
        message: "I'm okay now.",
        history: [
          { author: 'user', content: 'I might hurt my neighbor.' },
          {
            author: 'marcus',
            content: 'Are you planning to hurt someone right now?',
            route: 'SAFETY',
            safetyKind: 'VIOLENCE_AMBIGUOUS',
            deferredSafetyTopic,
          },
        ],
        timezone: 'America/New_York',
      }),
    ).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      deferredSafetyTopic,
    });
    expect(dependencies.router.route).toHaveBeenCalledWith({
      message: "I'm okay now.",
      recentUserMessages: ['I might hurt my neighbor.'],
      pendingSafety: { kind: 'VIOLENCE_AMBIGUOUS', deferredSafetyTopic },
    });
    expect(dependencies.embeddings.createEmbeddings).not.toHaveBeenCalled();
  });

  it('conservatively reassesses a legacy safety response without a stored kind', async () => {
    const dependencies = fakeDependencies();
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        route: 'SAFETY',
        reason: 'SAFETY_FOLLOW_UP_REQUIRED',
        retrieve: false,
        safetyKind: 'OTHER',
      }),
    );

    await new MeditationsChatService(dependencies).respond({
      message: "I'm okay now.",
      history: [
        { author: 'user', content: 'I might hurt someone.' },
        {
          author: 'marcus',
          content: 'Are you planning to hurt someone right now?',
          route: 'SAFETY',
        },
      ],
      timezone: 'America/New_York',
    });

    expect(dependencies.router.route).toHaveBeenCalledWith(
      expect.objectContaining({ pendingSafety: { kind: null } }),
    );
  });

  it('uses only a resolved continuation downstream and acknowledges the transition', async () => {
    const dependencies = fakeDependencies();
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        effectiveMessage: 'Help me reflect on my anger.',
        safetyFollowUpStatus: 'RESOLVED',
      }),
    );
    const service = new MeditationsChatService(dependencies);

    const response = await service.respond({
      message: "I'm not going to hurt anyone. Help me reflect on my anger.",
      history: [
        { author: 'user', content: 'I might hurt my neighbor.' },
        {
          author: 'marcus',
          content: 'Are you planning to hurt someone right now?',
          route: 'SAFETY',
          safetyKind: 'VIOLENCE_AMBIGUOUS',
        },
      ],
      timezone: 'America/New_York',
    });

    expect(response).toMatchObject({
      route: 'IN_SCOPE',
      safetyKind: null,
      message: expect.stringMatching(/^Thanks for answering directly\. We can continue\./u),
    });
    expect(dependencies.embeddings.createEmbeddings).toHaveBeenCalledWith([
      'Help me reflect on my anger.',
    ]);
    expect(dependencies.answers.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Help me reflect on my anger.',
        history: [],
      }),
    );
  });

  it('uses only a resumed deferred message downstream and names its topic', async () => {
    const dependencies = fakeDependencies();
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    dependencies.router.route.mockResolvedValue(
      routingDecision({
        effectiveMessage: deferredSafetyTopic.message,
        safetyFollowUpStatus: 'RESOLVED',
        resumedDeferredSafetyTopic: deferredSafetyTopic,
      }),
    );
    const service = new MeditationsChatService(dependencies);

    const response = await service.respond({
      message:
        "I'm not going to hurt anyone, the plan is off, I put the object down, and I left the area.",
      history: [
        { author: 'user', content: deferredSafetyTopic.message },
        {
          author: 'marcus',
          content: 'Before we discuss that, I need to make sure everyone is safe.',
          route: 'SAFETY',
          safetyKind: 'VIOLENCE_IMMINENT',
          deferredSafetyTopic,
        },
      ],
      timezone: 'America/New_York',
    });

    expect(response).toMatchObject({
      route: 'IN_SCOPE',
      deferredSafetyTopic: null,
      message: expect.stringMatching(
        /^Thanks for answering directly\. We can continue with your concerns about AI and job security\./u,
      ),
    });
    expect(dependencies.embeddings.createEmbeddings).toHaveBeenCalledWith([
      deferredSafetyTopic.message,
    ]);
    expect(dependencies.answers.generate).toHaveBeenCalledWith(
      expect.objectContaining({ message: deferredSafetyTopic.message, history: [] }),
    );
  });

  it.each([
    ['ABUSE', 'My abusive partner threatens me.'],
    ['EATING_DISORDER', "I don't deserve food."],
    ['REALITY_DISTRESS', 'The voices are speaking into my thoughts.'],
    ['OTHER', 'This is another urgent crisis.'],
  ] as const)('does not keep %s safety sticky', async (safetyKind, priorMessage) => {
    const dependencies = fakeDependencies();
    const service = new MeditationsChatService(dependencies);

    await service.respond({
      message: 'What did Marcus say about courage?',
      history: [
        { author: 'user', content: priorMessage },
        {
          author: 'marcus',
          content: 'Please seek appropriate human support.',
          route: 'SAFETY',
          safetyKind,
        },
      ],
      timezone: 'America/New_York',
    });

    expect(dependencies.router.route).toHaveBeenCalledWith({
      message: 'What did Marcus say about courage?',
      recentUserMessages: [],
    });
  });

  it('drops a completed safety segment but retains later conversation context', async () => {
    const dependencies = fakeDependencies();
    await new MeditationsChatService(dependencies).respond({
      message: 'What did he say about self-control?',
      history: [
        { author: 'user', content: 'I might hurt my neighbor.' },
        {
          author: 'marcus',
          content: 'Are you planning to hurt someone right now?',
          route: 'SAFETY',
          safetyKind: 'VIOLENCE_AMBIGUOUS',
        },
        { author: 'user', content: 'I am not thinking about hurting anyone now.' },
        {
          author: 'marcus',
          content: 'Thanks for answering directly.',
          route: 'NEEDS_CLARIFICATION',
        },
        { author: 'user', content: 'I want to reflect on anger.' },
        {
          author: 'marcus',
          content: 'Let us examine that judgment.',
          route: 'IN_SCOPE',
        },
      ],
      timezone: 'America/New_York',
    });

    expect(dependencies.router.route).toHaveBeenCalledWith({
      message: 'What did he say about self-control?',
      recentUserMessages: ['I want to reflect on anger.'],
    });
  });

  it('uses a fixed abstention when retrieved evidence is insufficient', async () => {
    const dependencies = fakeDependencies();
    dependencies.answers.generate.mockResolvedValue({
      sufficientEvidence: false,
      answer: 'The evidence does not address that.',
      citedReferences: [],
    });

    const response = await new MeditationsChatService(dependencies).respond(
      request('What did Marcus think about artificial intelligence?'),
    );
    expect(response.route).toBe('IN_SCOPE');
    expect(response.citations).toEqual([]);
    expect(response.message).toContain("couldn't find a passage");
    expect(response.message).not.toContain('artificial intelligence is');
  });

  it('rejects a retrieved quote that is not an exact part of its canonical parent', async () => {
    const dependencies = fakeDependencies();
    dependencies.pinecone.queryByVector.mockResolvedValue([
      {
        ...match(),
        metadata: {
          ...match().metadata,
          chunk_text: 'A passage that does not occur in the canonical parent.',
        },
      },
    ]);

    await expect(
      new MeditationsChatService(dependencies).respond(request('Help me focus.')),
    ).rejects.toThrowError(/child text outside its canonical parent/);
    expect(dependencies.answers.generate).not.toHaveBeenCalled();
  });

  it('preflights a standard 1536-dimensional index at server startup', async () => {
    const dependencies = fakeDependencies();
    const service = new MeditationsChatService(dependencies);

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(dependencies.pinecone.validateIndexConfiguration).toHaveBeenCalledOnce();

    dependencies.pinecone.validateIndexConfiguration.mockResolvedValue({
      name: 'meditations',
      host: 'example.svc.pinecone.io',
      ready: true,
      vectorType: 'dense',
      dimension: 1024,
      metric: 'cosine',
      integratedEmbedding: false,
    });
    await expect(service.initialize()).rejects.toThrowError(/1536-dimensional/);
  });
});

describe('OpenAIGroundedAnswerClient', () => {
  it('uses GPT-5.6 Sol with low reasoning and a strict citation schema', async () => {
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
                  sufficient_evidence: true,
                  answer: 'Attend to the present. Meditations 8.36',
                  cited_references: ['8.36'],
                }),
              },
            ],
          },
        ],
      }),
    );
    const client = new OpenAIGroundedAnswerClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.generate({
        message: "I'm anxious.",
        history: [],
        evidence: [
          {
            canonicalRef: '8.36',
            parentText: 'Do not disturb thyself by thinking of the whole of thy life.',
            quoteText: 'Do not disturb thyself by thinking of the whole of thy life.',
            sourceUrl: 'https://en.wikisource.org/wiki/Meditations/Book_VIII',
          },
        ],
      }),
    ).resolves.toEqual({
      sufficientEvidence: true,
      answer: 'Attend to the present. Meditations 8.36',
      citedReferences: ['8.36'],
    });
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'low' },
      store: false,
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', strict: true },
      },
    });
    expect(body.text.format.schema.properties.cited_references.items.enum).toEqual(['8.36']);
    expect(body.instructions).toContain('application renders the exact retrieved source text');
  });

  it('rejects a model citation that was not supplied as evidence', async () => {
    const client = new OpenAIGroundedAnswerClient({
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
                    sufficient_evidence: true,
                    answer: 'Invented answer.',
                    cited_references: ['12.99'],
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(
      client.generate({
        message: 'Question',
        history: [],
        evidence: [
          {
            canonicalRef: '8.36',
            parentText: 'Evidence.',
            quoteText: 'Evidence.',
            sourceUrl: 'https://en.wikisource.org/wiki/Meditations/Book_VIII',
          },
        ],
      }),
    ).rejects.toThrowError(/not supplied/);
  });
});

function fakeDependencies() {
  return {
    router: {
      route: vi.fn(async () => routingDecision()),
    },
    embeddings: {
      createEmbeddings: vi.fn(async () => [[0.1, 0.2]] as const),
    },
    pinecone: {
      validateIndexConfiguration: vi.fn(async () => ({
        name: 'meditations',
        host: 'example.svc.pinecone.io',
        ready: true,
        vectorType: 'dense',
        dimension: 1536,
        metric: 'cosine',
        integratedEmbedding: false,
      })),
      queryByVector: vi.fn(async () => [match()]),
    },
    answers: {
      generate: vi.fn(async () => ({
        sufficientEvidence: true,
        answer: 'Attend to what is present. Meditations 8.36',
        citedReferences: ['8.36'],
      })),
    },
    scheduling: {
      propose: vi.fn(async () => ({
        message: 'Review the time.',
        proposal: null as MeditationScheduleProposal | null,
      })),
    },
    namespace: 'long-1862',
    embeddingModel: 'text-embedding-3-small',
  };
}

function routingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    route: 'IN_SCOPE',
    reason: 'PERSONAL_REFLECTION',
    retrieve: true,
    source: 'classifier',
    userMessage: 'This can be explored using the Meditations corpus.',
    ...overrides,
  };
}

function request(message: string): ChatApiRequest {
  return {
    message,
    history: [{ author: 'marcus', content: 'What troubles your mind today?' }],
    timezone: 'America/New_York',
  };
}

function match(): PineconeQueryMatch {
  return {
    id: 'child-8-36-1',
    score: 0.33,
    metadata: {
      parent_id: 'parent-8-36',
      canonical_ref: '8.36',
      parent_text: 'Do not disturb thyself by thinking of the whole of thy life.',
      chunk_text: 'Do not disturb thyself by thinking of the whole of thy life.',
      source_url: 'https://en.wikisource.org/wiki/Meditations/Book_VIII',
      embedding_model: 'text-embedding-3-small',
      embedding_dimensions: 1536,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
