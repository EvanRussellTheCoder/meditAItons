import type {
  MeditationBookingResponse,
  MeditationScheduleConfirmation,
} from '../models/chat.models';
import {
  logSchedulingConfirmation,
  logSchedulingProposalDecision,
  logSchedulingResult,
  observeStage,
} from '../observability';
import { validDate, validTimezone, zonedDateContext } from './openai-scheduling';
import type {
  MeditationCalendarGateway,
  MeditationSchedulingConfirmationGateway,
  MeditationSchedulingGateway,
  SchedulingExtractionGateway,
  SchedulingProposalRequest,
  SchedulingProposalResult,
} from './types';
import { SchedulingOperationError } from './types';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PROPOSAL_TTL_MS = 30 * 60 * 1_000;

interface StoredProposal {
  readonly expiresAt: number;
  status: 'pending' | 'in_flight' | 'booked' | 'uncertain';
}

export interface MeditationSchedulerDependencies {
  readonly extraction: SchedulingExtractionGateway;
  readonly calendar: MeditationCalendarGateway;
  readonly now?: () => Date;
  readonly createProposalId?: () => string;
}

export class MeditationScheduler
  implements MeditationSchedulingGateway, MeditationSchedulingConfirmationGateway
{
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly now: () => Date;
  private readonly createProposalId: () => string;

  constructor(private readonly dependencies: MeditationSchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createProposalId = dependencies.createProposalId ?? (() => crypto.randomUUID());
  }

  /**
   * Plain-English pseudocode for proposing a meditation time:
   * 1. Validate the browser timezone and extract date/time intent from the conversation.
   * 2. Ask a clarifying question when the request is genuinely ambiguous.
   * 3. Otherwise apply safe defaults for omitted date or time.
   * 4. Store a short-lived, one-time proposal and return a confirmation card.
   * 5. Do not contact Cal.com during this proposal step.
   */
  async propose(request: SchedulingProposalRequest): Promise<SchedulingProposalResult> {
    if (!validTimezone(request.timezone)) {
      throw new SchedulingOperationError(
        400,
        'invalid_timezone',
        'The browser supplied an invalid timezone.',
        true,
      );
    }
    const currentDate = this.now();
    const extraction = await observeStage('scheduling', request.requestId, () =>
      this.dependencies.extraction.extract({ ...request, currentDate }),
    );
    if (extraction.status === 'needs_clarification') {
      logSchedulingProposalDecision({
        requestId: request.requestId,
        extraction,
        selectedDate: null,
        selectedTime: null,
        timezone: request.timezone,
        durationMinutes: this.dependencies.calendar.durationMinutes,
      });
      return {
        message:
          extraction.clarificationMessage ??
          'What date and time would you like to set aside for meditation?',
        proposal: null,
      };
    }
    const localToday = zonedDateContext(currentDate, request.timezone).date;
    const selectedDate = extraction.suggestedDate ?? nextBusinessDate(localToday);
    const selectedTime = extraction.suggestedTime ?? '09:00';
    const proposalId = this.createProposalId();
    this.prune(currentDate.getTime());
    this.proposals.set(proposalId, {
      expiresAt: currentDate.getTime() + PROPOSAL_TTL_MS,
      status: 'pending',
    });
    logSchedulingProposalDecision({
      requestId: request.requestId,
      extraction,
      selectedDate,
      selectedTime,
      timezone: request.timezone,
      durationMinutes: this.dependencies.calendar.durationMinutes,
      proposalId,
    });
    return {
      message:
        'I prepared a meditation time for your review. Check the details below—nothing will be added to your calendar until you confirm.',
      proposal: {
        proposalId,
        suggestedDate: selectedDate,
        suggestedTime: selectedTime,
        timezone: request.timezone,
        durationMinutes: this.dependencies.calendar.durationMinutes,
      },
    };
  }

  /**
   * Plain-English pseudocode for the confirmed write:
   * 1. Validate the edited card and require one unexpired pending proposal.
   * 2. Convert the local wall-clock choice to one unambiguous future UTC instant.
   * 3. Mark the proposal in flight before making exactly one Cal.com booking request.
   * 4. Allow correction after a definite rejection, but block retries when the outcome is uncertain.
   * 5. Mark a well-formed provider success as booked and return its confirmed details.
   */
  async confirm(
    request: MeditationScheduleConfirmation,
    requestId?: string,
  ): Promise<MeditationBookingResponse> {
    validateConfirmation(request);
    const now = this.now();
    this.prune(now.getTime());
    const stored = this.proposals.get(request.proposalId);
    if (!stored) {
      throw new SchedulingOperationError(
        409,
        'proposal_expired',
        'This meditation proposal expired. Ask the chat to create a new one.',
        false,
      );
    }
    if (stored.status !== 'pending') {
      const uncertain = stored.status === 'uncertain';
      throw new SchedulingOperationError(
        409,
        uncertain ? 'booking_status_uncertain' : 'duplicate_confirmation',
        uncertain
          ? 'The prior booking result is uncertain. Check Cal.com before trying again.'
          : 'This meditation proposal has already been submitted.',
        false,
      );
    }
    const startUtc = localWallClockToUtc(request.date, request.time, request.timezone);
    if (Date.parse(startUtc) <= now.getTime()) {
      throw new SchedulingOperationError(
        400,
        'time_not_future',
        'Choose a meditation time in the future.',
        true,
      );
    }

    stored.status = 'in_flight';
    logSchedulingConfirmation({
      requestId,
      action: 'submit_confirmed_booking',
      proposalId: request.proposalId,
      date: request.date,
      time: request.time,
      timezone: request.timezone,
      startUtc,
    });
    let result;
    try {
      result = await observeStage('cal.com', requestId, async () => {
        const calendarResult = await this.dependencies.calendar.book({
          proposalId: request.proposalId,
          startUtc,
          timezone: request.timezone,
          attendeeName: request.attendeeName.trim(),
          attendeeEmail: request.attendeeEmail.trim(),
        });
        if (!calendarResult.success) {
          throw new CalendarBookingResultError(calendarResult);
        }
        return calendarResult;
      });
    } catch (error) {
      if (!(error instanceof CalendarBookingResultError)) {
        stored.status = 'uncertain';
        logSchedulingResult({
          requestId,
          action: 'booking_rejected',
          proposalId: request.proposalId,
          errorCode: 'calendar_network_error',
          outcomeUncertain: true,
          retryable: false,
        });
        throw error;
      }
      const calendarFailure = error.result;
      stored.status = calendarFailure.outcomeUncertain ? 'uncertain' : 'pending';
      logSchedulingResult({
        requestId,
        action: 'booking_rejected',
        proposalId: request.proposalId,
        errorCode: calendarFailure.errorCode,
        outcomeUncertain: calendarFailure.outcomeUncertain,
        retryable: !calendarFailure.outcomeUncertain,
      });
      throw new SchedulingOperationError(
        calendarFailure.statusCode,
        calendarFailure.errorCode,
        calendarFailure.message,
        !calendarFailure.outcomeUncertain,
      );
    }
    stored.status = 'booked';
    logSchedulingResult({
      requestId,
      action: 'booking_created',
      proposalId: request.proposalId,
      bookingUid: result.bookingUid,
      retryable: false,
    });
    return {
      success: true,
      bookingUid: result.bookingUid,
      date: request.date,
      time: request.time,
      timezone: request.timezone,
      startUtc: result.startUtc,
      durationMinutes: result.durationMinutes,
      message: `Your meditation time is scheduled for ${request.date} at ${request.time}.`,
    };
  }

  private prune(now: number): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now && proposal.status !== 'in_flight') {
        this.proposals.delete(id);
      }
    }
  }
}

class CalendarBookingResultError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    readonly result: Extract<
      Awaited<ReturnType<MeditationCalendarGateway['book']>>,
      { success: false }
    >,
  ) {
    super('Cal.com returned an unsuccessful booking result.');
    this.name = 'CalendarBookingResultError';
    this.status = result.statusCode;
    this.code = result.errorCode;
  }
}

function validateConfirmation(request: MeditationScheduleConfirmation): void {
  if (
    !request.proposalId.trim() ||
    !validDate(request.date) ||
    !TIME_PATTERN.test(request.time) ||
    !validTimezone(request.timezone) ||
    !request.attendeeName.trim() ||
    request.attendeeName.trim().length > 120 ||
    !EMAIL_PATTERN.test(request.attendeeEmail.trim()) ||
    request.attendeeEmail.trim().length > 254
  ) {
    throw new SchedulingOperationError(
      400,
      'invalid_confirmation',
      'Check the name, email, date, time, and timezone before confirming.',
      true,
    );
  }
}

export function localWallClockToUtc(date: string, time: string, timezone: string): string {
  if (!validDate(date) || !TIME_PATTERN.test(time) || !validTimezone(timezone)) {
    throw new SchedulingOperationError(
      400,
      'invalid_local_time',
      'The selected local date, time, or timezone is invalid.',
      true,
    );
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const oneDay = 24 * 60 * 60 * 1_000;
  const offsets = new Set(
    [localAsUtc - oneDay, localAsUtc, localAsUtc + oneDay].map((instant) =>
      timezoneOffsetMilliseconds(instant, timezone),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((instant) => zonedPartsMatch(instant, timezone, year, month, day, hour, minute));
  if (candidates.length === 0) {
    throw new SchedulingOperationError(
      400,
      'invalid_local_time',
      'That local time does not exist because of a daylight-saving transition.',
      true,
    );
  }
  if (candidates.length > 1) {
    throw new SchedulingOperationError(
      400,
      'ambiguous_local_time',
      'That local time occurs twice. Choose a different time.',
      true,
    );
  }
  return new Date(candidates[0]).toISOString();
}

function timezoneOffsetMilliseconds(instant: number, timezone: string): number {
  const parts = zonedDateTimeParts(instant, timezone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    Math.floor(instant / 60_000) * 60_000
  );
}

function zonedPartsMatch(
  instant: number,
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const parts = zonedDateTimeParts(instant, timezone);
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute
  );
}

function zonedDateTimeParts(instant: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
  };
}

function nextBusinessDate(currentDate: string): string {
  const date = new Date(`${currentDate}T12:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}
