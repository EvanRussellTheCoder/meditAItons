import type { MeditationCalendarGateway } from './types';
import { MeditationScheduler, localWallClockToUtc } from './meditation-scheduler';

describe('MeditationScheduler', () => {
  it('creates an editable proposal and never books before explicit confirmation', async () => {
    const calendar = successfulCalendar();
    const scheduler = schedulerWith(calendar);

    const proposal = await scheduler.propose({
      message: 'Schedule meditation Tuesday at 7.',
      history: [],
      timezone: 'America/New_York',
    });

    expect(proposal.proposal).toEqual({
      proposalId: 'proposal-1',
      suggestedDate: '2026-08-18',
      suggestedTime: '19:00',
      timezone: 'America/New_York',
      durationMinutes: 30,
    });
    expect(calendar.book).not.toHaveBeenCalled();

    await expect(
      scheduler.confirm({
        proposalId: 'proposal-1',
        date: '2026-08-18',
        time: '19:00',
        timezone: 'America/New_York',
        attendeeName: 'Test User',
        attendeeEmail: 'test@example.com',
      }),
    ).resolves.toMatchObject({ success: true, bookingUid: 'booking-1' });
    expect(calendar.book).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      startUtc: '2026-08-18T23:00:00.000Z',
      timezone: 'America/New_York',
      attendeeName: 'Test User',
      attendeeEmail: 'test@example.com',
    });
  });

  it('asks for clarification without issuing a proposal when constraints conflict', async () => {
    const calendar = successfulCalendar();
    const scheduler = new MeditationScheduler({
      extraction: {
        extract: vi.fn(async () => ({
          status: 'needs_clarification' as const,
          suggestedDate: null,
          suggestedTime: null,
          ambiguity: 'time' as const,
          clarificationMessage: 'Did you mean 7 AM or 7 PM?',
        })),
      },
      calendar,
      now: () => new Date('2026-08-13T16:00:00.000Z'),
    });

    await expect(
      scheduler.propose({ message: 'At 7.', history: [], timezone: 'America/New_York' }),
    ).resolves.toEqual({ message: 'Did you mean 7 AM or 7 PM?', proposal: null });
    expect(calendar.book).not.toHaveBeenCalled();
  });

  it('blocks duplicate confirmation of the same one-time proposal', async () => {
    const calendar = successfulCalendar();
    const scheduler = schedulerWith(calendar);
    await scheduler.propose({ message: 'Schedule it.', history: [], timezone: 'UTC' });
    const confirmation = {
      proposalId: 'proposal-1',
      date: '2026-08-18',
      time: '19:00',
      timezone: 'UTC',
      attendeeName: 'Test User',
      attendeeEmail: 'test@example.com',
    };
    await scheduler.confirm(confirmation);

    await expect(scheduler.confirm(confirmation)).rejects.toMatchObject({
      code: 'duplicate_confirmation',
      retryable: false,
    });
    expect(calendar.book).toHaveBeenCalledTimes(1);
  });
});

describe('localWallClockToUtc', () => {
  it('converts an unambiguous IANA wall time to UTC', () => {
    expect(localWallClockToUtc('2026-08-18', '19:00', 'America/New_York')).toBe(
      '2026-08-18T23:00:00.000Z',
    );
  });

  it('rejects daylight-saving gaps and repeated wall times', () => {
    expect(() => localWallClockToUtc('2026-03-08', '02:30', 'America/New_York')).toThrowError(
      /does not exist/,
    );
    expect(() => localWallClockToUtc('2026-11-01', '01:30', 'America/New_York')).toThrowError(
      /occurs twice/,
    );
  });
});

function schedulerWith(calendar: MeditationCalendarGateway) {
  return new MeditationScheduler({
    extraction: {
      extract: vi.fn(async () => ({
        status: 'ready' as const,
        suggestedDate: '2026-08-18',
        suggestedTime: '19:00',
        ambiguity: 'none' as const,
        clarificationMessage: null,
      })),
    },
    calendar,
    now: () => new Date('2026-08-13T16:00:00.000Z'),
    createProposalId: () => 'proposal-1',
  });
}

function successfulCalendar() {
  return {
    durationMinutes: 30,
    book: vi.fn(async (request: { readonly startUtc: string }) => ({
      success: true as const,
      bookingUid: 'booking-1',
      startUtc: request.startUtc,
      endUtc: '2026-08-18T23:30:00.000Z',
      durationMinutes: 30,
    })),
  };
}
