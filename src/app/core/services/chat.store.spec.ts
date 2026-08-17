import { TestBed } from '@angular/core/testing';
import { ChatApiResponse } from '../models/chat.models';
import { ChatApiClient } from './chat-api.client';
import { ChatStore } from './chat.store';

describe('ChatStore', () => {
  let store: ChatStore;
  let api: { reply: ReturnType<typeof vi.fn>; schedule: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    api = { reply: vi.fn(), schedule: vi.fn() };
    TestBed.configureTestingModule({
      providers: [{ provide: ChatApiClient, useValue: api }],
    });
    store = TestBed.inject(ChatStore);
  });

  it('starts with the seeded conversation', () => {
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0].author).toBe('marcus');
  });

  it('adds the user message and the server-grounded reply with citations', async () => {
    api.reply.mockResolvedValue(
      response({
        message: 'Attend to the present task. Meditations 8.36',
        citations: [
          {
            canonicalRef: '8.36',
            quote: 'Do not disturb thyself by thinking of the whole of thy life.',
            sourceUrl:
              'https://en.wikisource.org/wiki/The_Thoughts_of_the_Emperor_Marcus_Aurelius_Antoninus/Book_VIII',
          },
        ],
      }),
    );

    store.send('I am worried about tomorrow');

    expect(store.isResponding()).toBe(true);
    expect(store.messages().at(-1)?.author).toBe('user');
    await vi.waitFor(() => expect(store.isResponding()).toBe(false));

    expect(store.messages().at(-1)).toMatchObject({
      author: 'marcus',
      content: 'Attend to the present task. Meditations 8.36',
      route: 'IN_SCOPE',
      citations: [
        {
          canonicalRef: '8.36',
          quote: 'Do not disturb thyself by thinking of the whole of thy life.',
        },
      ],
    });
    expect(api.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'I am worried about tomorrow',
        history: expect.arrayContaining([
          expect.objectContaining({ author: 'marcus', content: 'What troubles your mind today?' }),
        ]),
      }),
    );
  });

  it('shows a bounded connection failure and always clears the responding state', async () => {
    api.reply.mockRejectedValue(new Error('offline'));
    store.send('I feel calm.');

    await vi.waitFor(() => expect(store.isResponding()).toBe(false));
    expect(store.messages().at(-1)?.content).toContain("couldn't reach");
    expect(store.messages().at(-1)?.content).not.toContain('offline');
  });

  it('ignores a late response after the conversation is reset', async () => {
    let resolveReply!: (value: ChatApiResponse) => void;
    api.reply.mockReturnValue(
      new Promise<ChatApiResponse>((resolve) => {
        resolveReply = resolve;
      }),
    );
    store.send('I feel calm.');
    store.reset();
    resolveReply(response());
    await Promise.resolve();

    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0].content).toBe('What troubles your mind today?');
    expect(store.isResponding()).toBe(false);
  });

  it('ignores blank messages', () => {
    const count = store.messageCount();
    store.send('   ');
    expect(store.messageCount()).toBe(count);
    expect(api.reply).not.toHaveBeenCalled();
  });

  it('shows a confirmation proposal and books only after explicit confirmation', async () => {
    api.reply.mockResolvedValue(
      response({
        route: 'SCHEDULE',
        reason: 'MEDITATION_SCHEDULING',
        message: 'Review the details.',
        schedulingProposal: {
          proposalId: 'proposal-1',
          suggestedDate: '2026-08-18',
          suggestedTime: '19:00',
          timezone: 'America/New_York',
          durationMinutes: 30,
        },
      }),
    );
    api.schedule.mockResolvedValue({
      success: true,
      bookingUid: 'booking-1',
      date: '2026-08-18',
      time: '19:00',
      timezone: 'America/New_York',
      startUtc: '2026-08-18T23:00:00.000Z',
      durationMinutes: 30,
      message: 'Your meditation time is scheduled.',
    });

    store.send('Schedule meditation Tuesday at 7.');
    await vi.waitFor(() => expect(store.pendingSchedule()?.proposalId).toBe('proposal-1'));
    expect(api.schedule).not.toHaveBeenCalled();

    store.confirmSchedule({
      date: '2026-08-18',
      time: '19:00',
      timezone: 'America/New_York',
      attendeeName: 'Test User',
      attendeeEmail: 'test@example.com',
    });
    await vi.waitFor(() => expect(store.isScheduling()).toBe(false));

    expect(api.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'proposal-1' }),
    );
    expect(store.pendingSchedule()).toBeNull();
    expect(store.messages().at(-1)).toMatchObject({ route: 'SCHEDULE' });
  });

  it('resets to a single welcome message', () => {
    store.reset();
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0].content).toBe('What troubles your mind today?');
  });
});

function response(overrides: Partial<ChatApiResponse> = {}): ChatApiResponse {
  return {
    route: 'IN_SCOPE',
    reason: 'PERSONAL_REFLECTION',
    message: 'A grounded response.',
    citations: [],
    schedulingProposal: null,
    ...overrides,
  };
}
