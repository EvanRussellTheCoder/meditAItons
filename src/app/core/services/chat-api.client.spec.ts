import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ChatApiClient } from './chat-api.client';

describe('ChatApiClient', () => {
  let client: ChatApiClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(ChatApiClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts bounded chat state to the same-origin API and validates citations', async () => {
    const promise = client.reply({
      message: "I'm happy.",
      history: [{ author: 'marcus', content: 'What troubles your mind today?' }],
      timezone: 'America/New_York',
    });
    const request = http.expectOne('/api/chat');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      message: "I'm happy.",
      history: [{ author: 'marcus', content: 'What troubles your mind today?' }],
      timezone: 'America/New_York',
    });
    request.flush({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'Receive the moment without arrogance. Meditations 8.33',
      citations: [
        {
          canonicalRef: '8.33',
          quote: 'Receive without pride, let go without attachment.',
          sourceUrl: 'https://en.wikisource.org/wiki/Example/Book_VIII',
        },
      ],
      schedulingProposal: null,
    });

    await expect(promise).resolves.toMatchObject({
      route: 'IN_SCOPE',
      citations: [
        {
          canonicalRef: '8.33',
          quote: 'Receive without pride, let go without attachment.',
        },
      ],
    });
  });

  it('rejects a citation that is not an HTTPS Wikisource URL', async () => {
    const promise = client.reply({
      message: "I'm happy.",
      history: [],
      timezone: 'America/New_York',
    });
    http.expectOne('/api/chat').flush({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'Answer',
      citations: [
        {
          canonicalRef: '8.33',
          quote: 'Receive without pride, let go without attachment.',
          sourceUrl: 'https://example.com/phishing',
        },
      ],
      schedulingProposal: null,
    });

    await expect(promise).rejects.toThrowError(/invalid response/);
  });

  it('rejects a citation without an exact quoted passage', async () => {
    const promise = client.reply({
      message: "I'm happy.",
      history: [],
      timezone: 'America/New_York',
    });
    http.expectOne('/api/chat').flush({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'Answer',
      citations: [
        {
          canonicalRef: '8.33',
          sourceUrl: 'https://en.wikisource.org/wiki/Example/Book_VIII',
        },
      ],
      schedulingProposal: null,
    });

    await expect(promise).rejects.toThrowError(/invalid response/);
  });

  it('accepts a schedule proposal only on the SCHEDULE route', async () => {
    const promise = client.reply({
      message: 'Schedule meditation Tuesday at 7.',
      history: [],
      timezone: 'America/New_York',
    });
    http.expectOne('/api/chat').flush({
      route: 'SCHEDULE',
      reason: 'MEDITATION_SCHEDULING',
      safetyKind: null,
      deferredSafetyTopic: null,
      message: 'Review the details.',
      citations: [],
      schedulingProposal: {
        proposalId: 'proposal-1',
        suggestedDate: '2026-08-18',
        suggestedTime: '19:00',
        timezone: 'America/New_York',
        durationMinutes: 30,
      },
    });

    await expect(promise).resolves.toMatchObject({
      route: 'SCHEDULE',
      schedulingProposal: { proposalId: 'proposal-1' },
    });
  });

  it('sends and validates pending safety metadata', async () => {
    const deferredSafetyTopic = {
      label: 'your concerns about AI and job security',
      message: 'Can we talk about my fear of AI replacing me at work?',
    } as const;
    const history = [
      { author: 'user' as const, content: 'I might hurt someone.' },
      {
        author: 'marcus' as const,
        content: 'Are you thinking about hurting anyone right now?',
        route: 'SAFETY' as const,
        safetyKind: 'VIOLENCE_AMBIGUOUS' as const,
        deferredSafetyTopic,
      },
    ];
    const promise = client.reply({
      message: "I'm okay now.",
      history,
      timezone: 'America/New_York',
    });
    const request = http.expectOne('/api/chat');
    expect(request.request.body.history).toEqual(history);
    request.flush({
      route: 'SAFETY',
      reason: 'SAFETY_FOLLOW_UP_REQUIRED',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      deferredSafetyTopic,
      message: 'Please answer the question directly.',
      citations: [],
      schedulingProposal: null,
    });

    await expect(promise).resolves.toMatchObject({
      route: 'SAFETY',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      deferredSafetyTopic,
    });
  });

  it('rejects safety-kind metadata that is inconsistent with the route', async () => {
    const promise = client.reply({
      message: "I'm happy.",
      history: [],
      timezone: 'America/New_York',
    });
    http.expectOne('/api/chat').flush({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: 'VIOLENCE_AMBIGUOUS',
      deferredSafetyTopic: null,
      message: 'Answer',
      citations: [],
      schedulingProposal: null,
    });

    await expect(promise).rejects.toThrowError(/invalid response/);
  });

  it('rejects deferred safety metadata outside an intent-based safety response', async () => {
    const promise = client.reply({
      message: "I'm happy.",
      history: [],
      timezone: 'America/New_York',
    });
    http.expectOne('/api/chat').flush({
      route: 'IN_SCOPE',
      reason: 'PERSONAL_REFLECTION',
      safetyKind: null,
      deferredSafetyTopic: {
        label: 'your concerns about AI and job security',
        message: 'Can we talk about my fear of AI replacing me at work?',
      },
      message: 'Answer',
      citations: [],
      schedulingProposal: null,
    });

    await expect(promise).rejects.toThrowError(/invalid response/);
  });

  it('posts a confirmed proposal to the separate scheduling endpoint', async () => {
    const confirmation = {
      proposalId: 'proposal-1',
      date: '2026-08-18',
      time: '19:00',
      timezone: 'America/New_York',
      attendeeName: 'Test User',
      attendeeEmail: 'test@example.com',
    };
    const promise = client.schedule(confirmation);
    const request = http.expectOne('/api/schedule');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(confirmation);
    request.flush({
      success: true,
      bookingUid: 'booking-1',
      date: confirmation.date,
      time: confirmation.time,
      timezone: confirmation.timezone,
      startUtc: '2026-08-18T23:00:00.000Z',
      durationMinutes: 30,
      message: 'Scheduled.',
    });

    await expect(promise).resolves.toMatchObject({ success: true, bookingUid: 'booking-1' });
  });
});
