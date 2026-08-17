import type { RoutingDecision } from '../routing';
import {
  logRoutingDecision,
  logSchedulingConfirmation,
  logSchedulingProposalDecision,
  observeStage,
  requestIdFromHeader,
} from './observability';

afterEach(() => vi.restoreAllMocks());

describe('pipeline observability', () => {
  it('logs stage duration and a safe error identity without exposing an error message', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(observeStage('selector', 'request-123', async () => 'ok')).resolves.toBe('ok');
    await expect(
      observeStage('cal.com', 'request-123', async () => {
        throw Object.assign(new Error('secret-key-and-provider-body'), {
          name: 'CalendarFailure',
          status: 403,
          code: 'calendar_permission_error',
        });
      }),
    ).rejects.toThrowError('secret-key-and-provider-body');

    const output = [...info.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(output).toContain('pipeline.stage.start');
    expect(output).toContain('pipeline.stage.success');
    expect(output).toContain('pipeline.stage.error');
    expect(output).toContain('calendar_permission_error');
    expect(output).not.toContain('secret-key-and-provider-body');
  });

  it('prints readable routing flags and redacts email addresses in the message preview', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logRoutingDecision({
      requestId: 'request-123',
      currentMessage: 'Schedule meditation Tuesday for person@example.com with sk-secretvalue12345',
      historyMessages: 3,
      decision: decision(),
    });

    const line = String(info.mock.calls[0]?.[0]);
    const payload = JSON.parse(line.replace('[routing] ', ''));
    expect(payload).toMatchObject({
      requestId: 'request-123',
      route: 'SCHEDULE',
      retrieveFromMeditations: false,
      useScheduler: true,
      useSafetyResponse: false,
      historyMessages: 3,
      currentMessage: 'Schedule meditation Tuesday for [EMAIL REDACTED] with [SECRET REDACTED]',
    });
  });

  it('logs proposal defaults and confirmation without logging attendee identity', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logSchedulingProposalDecision({
      requestId: 'request-123',
      extraction: {
        status: 'ready',
        suggestedDate: '2026-08-18',
        suggestedTime: null,
        ambiguity: 'none',
        clarificationMessage: null,
      },
      selectedDate: '2026-08-18',
      selectedTime: '09:00',
      timezone: 'America/New_York',
      durationMinutes: 30,
      proposalId: 'proposal-1',
    });
    logSchedulingConfirmation({
      requestId: 'request-123',
      action: 'submit_confirmed_booking',
      proposalId: 'proposal-1',
      date: '2026-08-18',
      time: '09:00',
      timezone: 'America/New_York',
      startUtc: '2026-08-18T13:00:00.000Z',
    });

    const output = info.mock.calls.flat().join('\n');
    expect(output).toContain('"timeSource": "default"');
    expect(output).toContain('"calendarWritePerformed": false');
    expect(output).toContain('"attendeeEmailProvided": true');
    expect(output).not.toContain('attendeeEmail"');
    expect(output).not.toContain('attendeeName"');
  });

  it('accepts only bounded log-safe request ids', () => {
    expect(requestIdFromHeader('client-request_123')).toBe('client-request_123');
    expect(requestIdFromHeader('bad id\nforged-log')).not.toBe('bad id\nforged-log');
    expect(requestIdFromHeader(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

function decision(): RoutingDecision {
  return {
    route: 'SCHEDULE',
    reason: 'MEDITATION_SCHEDULING',
    retrieve: false,
    source: 'classifier',
    userMessage: 'Review the scheduling proposal.',
  };
}
