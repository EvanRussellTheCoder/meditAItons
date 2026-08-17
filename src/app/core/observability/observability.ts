import type { RoutingDecision } from '../routing';
import type { SchedulingExtraction } from '../scheduling/types';

export type PipelineStage =
  | 'cal.com.preflight'
  | 'pinecone.preflight'
  | 'selector'
  | 'embedding'
  | 'pinecone'
  | 'grounded_answer'
  | 'scheduling'
  | 'cal.com';

export type SchedulingAction =
  | 'ask_clarifying_question'
  | 'show_confirmation_card'
  | 'submit_confirmed_booking'
  | 'booking_created'
  | 'booking_rejected';

interface RoutingLogInput {
  readonly requestId?: string;
  readonly currentMessage: string;
  readonly historyMessages: number;
  readonly decision: RoutingDecision;
}

interface SchedulingProposalLogInput {
  readonly requestId?: string;
  readonly extraction: SchedulingExtraction;
  readonly selectedDate: string | null;
  readonly selectedTime: string | null;
  readonly timezone: string;
  readonly durationMinutes: number;
  readonly proposalId?: string;
}

interface SchedulingConfirmationLogInput {
  readonly requestId?: string;
  readonly action: 'submit_confirmed_booking';
  readonly proposalId: string;
  readonly date: string;
  readonly time: string;
  readonly timezone: string;
  readonly startUtc: string;
}

interface SchedulingResultLogInput {
  readonly requestId?: string;
  readonly action: 'booking_created' | 'booking_rejected';
  readonly proposalId: string;
  readonly bookingUid?: string;
  readonly errorCode?: string;
  readonly outcomeUncertain?: boolean;
  readonly retryable?: boolean;
}

interface RequestLogInput {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly historyMessages?: number;
}

export async function observeStage<T>(
  stage: PipelineStage,
  requestId: string | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  if (!requestId) {
    return work();
  }
  const startedAt = Date.now();
  writePipelineLog('info', {
    event: 'pipeline.stage.start',
    requestId,
    stage,
  });
  try {
    const result = await work();
    writePipelineLog('info', {
      event: 'pipeline.stage.success',
      requestId,
      stage,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    writePipelineLog('error', {
      event: 'pipeline.stage.error',
      requestId,
      stage,
      durationMs: Date.now() - startedAt,
      status: statusFrom(error),
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: errorCodeFrom(error),
    });
    throw error;
  }
}

export function logRequestStarted(input: RequestLogInput): void {
  writePipelineLog('info', {
    event: 'pipeline.request.start',
    ...input,
  });
}

export function logRequestCompleted(
  input: RequestLogInput & {
    readonly status: number;
    readonly durationMs: number;
    readonly errorCode?: string;
  },
): void {
  writePipelineLog(input.status >= 500 ? 'error' : 'info', {
    event: 'pipeline.request.complete',
    ...input,
  });
}

export function logRoutingDecision({
  requestId,
  currentMessage,
  historyMessages,
  decision,
}: RoutingLogInput): void {
  if (!requestId) {
    return;
  }
  console.info(
    `[routing] ${JSON.stringify(
      {
        requestId,
        route: decision.route,
        reasonCode: decision.reason,
        reason: routingExplanation(decision),
        source: decision.source,
        retrieveFromMeditations: decision.retrieve,
        useScheduler: decision.route === 'SCHEDULE',
        useSafetyResponse: decision.route === 'SAFETY',
        askForClarification: decision.route === 'NEEDS_CLARIFICATION',
        safetyKind: decision.safetyKind ?? null,
        historyMessages,
        currentMessage: logSafePreview(currentMessage),
      },
      null,
      2,
    )}`,
  );
}

export function logSchedulingProposalDecision({
  requestId,
  extraction,
  selectedDate,
  selectedTime,
  timezone,
  durationMinutes,
  proposalId,
}: SchedulingProposalLogInput): void {
  if (!requestId) {
    return;
  }
  const asksForClarification = extraction.status === 'needs_clarification';
  console.info(
    `[scheduling] ${JSON.stringify(
      {
        requestId,
        phase: 'proposal',
        action: asksForClarification ? 'ask_clarifying_question' : 'show_confirmation_card',
        reason: asksForClarification
          ? `The scheduling constraints are ambiguous (${extraction.ambiguity}).`
          : 'The scheduling intent is ready for human review; no booking has been created.',
        extractionStatus: extraction.status,
        ambiguity: extraction.ambiguity,
        extractedDate: extraction.suggestedDate,
        extractedTime: extraction.suggestedTime,
        selectedDate,
        selectedTime,
        dateSource:
          selectedDate === null ? null : extraction.suggestedDate ? 'conversation' : 'default',
        timeSource:
          selectedTime === null ? null : extraction.suggestedTime ? 'conversation' : 'default',
        timezone,
        durationMinutes,
        proposalId: proposalId ?? null,
        calendarWritePerformed: false,
      },
      null,
      2,
    )}`,
  );
}

export function logSchedulingConfirmation(input: SchedulingConfirmationLogInput): void {
  if (!input.requestId) {
    return;
  }
  console.info(
    `[scheduling] ${JSON.stringify(
      {
        requestId: input.requestId,
        phase: 'confirmation',
        action: input.action,
        reason: 'The user confirmed the displayed details; the Cal.com write is now allowed.',
        proposalId: input.proposalId,
        date: input.date,
        time: input.time,
        timezone: input.timezone,
        startUtc: input.startUtc,
        attendeeNameProvided: true,
        attendeeEmailProvided: true,
        calendarWritePerformed: true,
      },
      null,
      2,
    )}`,
  );
}

export function logSchedulingResult(input: SchedulingResultLogInput): void {
  if (!input.requestId) {
    return;
  }
  console.info(
    `[scheduling] ${JSON.stringify(
      {
        requestId: input.requestId,
        phase: 'calendar_result',
        action: input.action,
        reason:
          input.action === 'booking_created'
            ? 'Cal.com confirmed the meditation booking.'
            : input.outcomeUncertain
              ? 'Cal.com did not provide a definitive outcome; duplicate submission is blocked.'
              : 'Cal.com definitively rejected the booking; the proposal may be edited and retried.',
        proposalId: input.proposalId,
        bookingUidPresent: Boolean(input.bookingUid),
        errorCode: input.errorCode ?? null,
        outcomeUncertain: input.outcomeUncertain ?? false,
        retryable: input.retryable ?? false,
      },
      null,
      2,
    )}`,
  );
}

export function requestIdFromHeader(value: string | readonly string[] | undefined): string {
  const supplied = Array.isArray(value) ? value[0] : value;
  return supplied && /^[A-Za-z0-9._-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
}

function routingExplanation(decision: RoutingDecision): string {
  switch (decision.route) {
    case 'IN_SCOPE':
      return 'The request can be answered from the Meditations corpus, so retrieval is allowed.';
    case 'SCHEDULE':
      return 'A request to schedule meditation was detected, so scheduling extraction runs without retrieval.';
    case 'REFRAME':
      return 'The outside request has a safe reflective angle, so the app offers a reframe without retrieval.';
    case 'OUT_OF_SCOPE':
      return 'The request is outside the corpus and action boundary, so no retrieval runs.';
    case 'NEEDS_CLARIFICATION':
      return 'The request cannot be routed confidently, so the app asks for clarification.';
    case 'SAFETY':
      return 'A safety concern takes priority over retrieval and scheduling.';
  }
}

function logSafePreview(value: string): string {
  const normalized = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[EMAIL REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [SECRET REDACTED]')
    .replace(/\bsk-[A-Z0-9_-]{8,}/giu, '[SECRET REDACTED]')
    .replace(/\b(?:pcsk|cal)_[A-Z0-9_-]{8,}/giu, '[SECRET REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
}

function statusFrom(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status)) {
      return status;
    }
  }
  return 500;
}

function errorCodeFrom(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function writePipelineLog(
  level: 'info' | 'error',
  payload: Readonly<Record<string, unknown>>,
): void {
  const line = `[pipeline] ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.info(line);
}
