import type {
  CalendarBookingRequest,
  CalendarBookingResult,
  MeditationCalendarGateway,
} from './types';

const CAL_BASE_URL = 'https://api.cal.com';
const EVENT_TYPE_API_VERSION = '2024-06-14';
const BOOKING_API_VERSION = '2026-02-25';

export interface CalComClientConfig {
  readonly apiKey: string;
  readonly eventTypeId: number;
  readonly fetchImplementation?: typeof fetch;
}

export class CalComClient implements MeditationCalendarGateway {
  durationMinutes = 0;

  private readonly apiKey: string;
  private readonly eventTypeId: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(config: CalComClientConfig) {
    if (!config.apiKey.trim()) {
      throw configurationError('CAL_API_KEY must not be empty');
    }
    if (!Number.isSafeInteger(config.eventTypeId) || config.eventTypeId <= 0) {
      throw configurationError('CAL_EVENT_TYPE_ID must be a positive integer');
    }
    this.apiKey = config.apiKey.trim();
    this.eventTypeId = config.eventTypeId;
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  /**
   * Plain-English pseudocode for the Cal.com boundary:
   * 1. At server startup, verify the configured event type, duration, and required fields.
   * 2. After explicit user confirmation, send one UTC booking request with attendee details.
   * 3. Accept only a well-formed 201 response with a booking UID as success.
   * 4. Separate definite rejections from uncertain network/server outcomes so callers do not duplicate bookings.
   */
  async initialize(): Promise<void> {
    const response = await this.fetchImplementation(
      `${CAL_BASE_URL}/v2/event-types/${encodeURIComponent(this.eventTypeId)}`,
      {
        headers: this.headers(EVENT_TYPE_API_VERSION),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = await readJson(response);
    if (
      !response.ok ||
      !isRecord(body) ||
      body['status'] !== 'success' ||
      !isRecord(body['data'])
    ) {
      throw configurationError(`Cal.com event type preflight failed with HTTP ${response.status}`);
    }
    const eventType = body['data'];
    if (Number(eventType['id']) !== this.eventTypeId) {
      throw configurationError('Cal.com returned a different event type');
    }
    const duration = Number(eventType['lengthInMinutes']);
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw configurationError('Cal.com event type has an invalid duration');
    }
    const bookingFields = Array.isArray(eventType['bookingFields'])
      ? eventType['bookingFields']
      : [];
    const unsupportedRequiredFields = bookingFields.filter(
      (field) =>
        isRecord(field) &&
        field['required'] === true &&
        !['name', 'email', 'title'].includes(String(field['slug'])),
    );
    if (unsupportedRequiredFields.length > 0) {
      throw configurationError('Cal.com event type has unsupported required booking fields');
    }
    this.durationMinutes = duration;
  }

  async book(request: CalendarBookingRequest): Promise<CalendarBookingResult> {
    if (this.durationMinutes <= 0) {
      throw configurationError('Cal.com client must be initialized before booking');
    }
    try {
      const response = await this.fetchImplementation(`${CAL_BASE_URL}/v2/bookings`, {
        method: 'POST',
        headers: {
          ...this.headers(BOOKING_API_VERSION),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          start: request.startUtc,
          eventTypeId: this.eventTypeId,
          attendee: {
            name: request.attendeeName,
            email: request.attendeeEmail,
            timeZone: request.timezone,
            language: 'en',
          },
          bookingFieldsResponses: {
            title: 'Meditation practice',
          },
          metadata: {
            proposalId: request.proposalId,
            source: 'meditaitons',
          },
        }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await readJson(response);
      if (response.status !== 201) {
        if (response.ok) {
          return failure(
            502,
            'calendar_invalid_response',
            'Cal.com returned an invalid response, so the booking status is uncertain.',
            true,
          );
        }
        return failureFor(response.status, body);
      }
      if (!isRecord(body) || body['status'] !== 'success' || !isRecord(body['data'])) {
        return failure(
          502,
          'calendar_invalid_response',
          'Cal.com returned an invalid response, so the booking status is uncertain.',
          true,
        );
      }
      const data = body['data'];
      if (typeof data['uid'] !== 'string' || !data['uid'].trim()) {
        return failure(
          502,
          'calendar_invalid_response',
          'Cal.com returned an invalid response, so the booking status is uncertain.',
          true,
        );
      }
      return {
        success: true,
        bookingUid: data['uid'],
        startUtc: typeof data['start'] === 'string' ? data['start'] : request.startUtc,
        endUtc: typeof data['end'] === 'string' ? data['end'] : null,
        durationMinutes:
          Number.isSafeInteger(data['duration']) && Number(data['duration']) > 0
            ? Number(data['duration'])
            : this.durationMinutes,
      };
    } catch {
      return failure(
        502,
        'calendar_network_error',
        'Cal.com could not be reached, so the booking status is uncertain.',
        true,
      );
    }
  }

  private headers(apiVersion: string): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'cal-api-version': apiVersion,
    };
  }
}

function failureFor(status: number, body: unknown): CalendarBookingResult {
  if (status === 401) {
    return failure(status, 'calendar_authentication_error', 'Cal.com rejected the API key.');
  }
  if (status === 403) {
    return failure(status, 'calendar_permission_error', 'Cal.com denied this booking.');
  }
  if (status === 409 || describesAvailabilityFailure(body)) {
    return failure(status, 'calendar_availability_error', 'That meditation time is unavailable.');
  }
  if (status === 429) {
    return failure(
      status,
      'calendar_rate_limit_error',
      'Cal.com is busy. Please try again shortly.',
    );
  }
  if (status >= 400 && status < 500) {
    return failure(status, 'calendar_validation_error', 'Cal.com rejected the booking details.');
  }
  return failure(
    status,
    'calendar_service_error',
    'Cal.com could not confirm whether the booking was created.',
    true,
  );
}

function failure(
  statusCode: number,
  errorCode: Exclude<CalendarBookingResult, { success: true }>['errorCode'],
  message: string,
  outcomeUncertain = false,
): CalendarBookingResult {
  return { success: false, statusCode, errorCode, message, outcomeUncertain };
}

function describesAvailabilityFailure(body: unknown): boolean {
  const normalized = safelyStringify(body).toLocaleLowerCase();
  return [
    'availability',
    'not available',
    'already booked',
    'booking limit',
    'outside booking',
  ].some((term) => normalized.includes(term));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function safelyStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configurationError(reason: string): Error {
  return new Error(`CalComConfigurationError: reason=${reason}`);
}
