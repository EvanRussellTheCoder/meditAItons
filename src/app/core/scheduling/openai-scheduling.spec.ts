import { OpenAISchedulingExtractor } from './openai-scheduling';

describe('OpenAISchedulingExtractor', () => {
  it('uses bounded conversation context, browser timezone, and strict structured output', async () => {
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
                  status: 'ready',
                  suggested_date: '2026-08-18',
                  suggested_time: '19:00',
                  ambiguity: 'none',
                  clarification_message: null,
                }),
              },
            ],
          },
        ],
      }),
    );
    const extractor = new OpenAISchedulingExtractor({ apiKey: 'test-key', fetchImplementation });

    await expect(
      extractor.extract({
        message: 'Tuesday at 7.',
        history: [
          { author: 'user', content: 'Please schedule time for me to meditate.' },
          { author: 'marcus', content: 'What day works?' },
        ],
        timezone: 'America/New_York',
        currentDate: new Date('2026-08-13T16:00:00.000Z'),
      }),
    ).resolves.toEqual({
      status: 'ready',
      suggestedDate: '2026-08-18',
      suggestedTime: '19:00',
      ambiguity: 'none',
      clarificationMessage: null,
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
          name: 'meditation_schedule_details',
          strict: true,
        },
      },
    });
    expect(body.instructions).toContain('America/New_York');
    expect(JSON.parse(body.input).recent_conversation).toHaveLength(2);
  });

  it('rejects an inconsistent ready response instead of guessing', async () => {
    const extractor = new OpenAISchedulingExtractor({
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
                    status: 'ready',
                    suggested_date: '2026-08-12',
                    suggested_time: '19:00',
                    ambiguity: 'none',
                    clarification_message: null,
                  }),
                },
              ],
            },
          ],
        }),
    });

    await expect(
      extractor.extract({
        message: 'Yesterday.',
        history: [],
        timezone: 'America/New_York',
        currentDate: new Date('2026-08-13T16:00:00.000Z'),
      }),
    ).rejects.toThrowError(/inconsistent scheduling details/);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
