import type {
  ChatHistoryMessage,
  MeditationBookingResponse,
  MeditationScheduleConfirmation,
  MeditationScheduleProposal,
} from '../models/chat.models';

export const MINIMUM_SCHEDULING_NOTICE_HOURS = 12;
export const MINIMUM_SCHEDULING_NOTICE_MESSAGE =
  'Meditation sessions need at least 12 hours\u2019 notice. Choose a later time so you can protect the space and arrive without rushing.';

export interface SchedulingExtractionRequest {
  readonly message: string;
  readonly history: readonly ChatHistoryMessage[];
  readonly timezone: string;
  readonly currentDate: Date;
}

export interface SchedulingExtraction {
  readonly status: 'ready' | 'needs_clarification';
  readonly suggestedDate: string | null;
  readonly suggestedTime: string | null;
  readonly ambiguity: 'none' | 'date' | 'time' | 'multiple';
  readonly clarificationMessage: string | null;
}

export interface SchedulingExtractionGateway {
  extract(request: SchedulingExtractionRequest): Promise<SchedulingExtraction>;
}

export interface SchedulingProposalRequest {
  readonly message: string;
  readonly history: readonly ChatHistoryMessage[];
  readonly timezone: string;
  /** Server-generated correlation id used only for terminal observability. */
  readonly requestId?: string;
}

export interface SchedulingProposalResult {
  readonly message: string;
  readonly proposal: MeditationScheduleProposal | null;
}

export interface MeditationSchedulingGateway {
  propose(request: SchedulingProposalRequest): Promise<SchedulingProposalResult>;
}

export interface MeditationSchedulingConfirmationGateway {
  confirm(
    request: MeditationScheduleConfirmation,
    requestId?: string,
  ): Promise<MeditationBookingResponse>;
}

export interface CalendarBookingRequest {
  readonly proposalId: string;
  readonly startUtc: string;
  readonly timezone: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
}

export type CalendarBookingErrorCode =
  | 'calendar_authentication_error'
  | 'calendar_permission_error'
  | 'calendar_validation_error'
  | 'calendar_availability_error'
  | 'calendar_rate_limit_error'
  | 'calendar_service_error'
  | 'calendar_invalid_response'
  | 'calendar_network_error';

export type CalendarBookingResult =
  | {
      readonly success: true;
      readonly bookingUid: string;
      readonly startUtc: string;
      readonly endUtc: string | null;
      readonly durationMinutes: number;
    }
  | {
      readonly success: false;
      readonly statusCode: number;
      readonly errorCode: CalendarBookingErrorCode;
      readonly message: string;
      readonly outcomeUncertain: boolean;
    };

export interface MeditationCalendarGateway {
  readonly durationMinutes: number;
  book(request: CalendarBookingRequest): Promise<CalendarBookingResult>;
}

export class SchedulingOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SchedulingOperationError';
  }
}
