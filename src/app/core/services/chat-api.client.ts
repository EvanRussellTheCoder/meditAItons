import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  ChatApiRequest,
  ChatApiResponse,
  ChatCitation,
  MeditationBookingResponse,
  MeditationScheduleConfirmation,
  MeditationScheduleProposal,
} from '../models/chat.models';
import { CONVERSATION_ROUTES, ROUTING_REASONS } from '../routing/types';

@Injectable({ providedIn: 'root' })
export class ChatApiClient {
  private readonly http = inject(HttpClient);

  async reply(request: ChatApiRequest): Promise<ChatApiResponse> {
    const response = await firstValueFrom(this.http.post<unknown>('/api/chat', request));
    return validateResponse(response);
  }

  async schedule(request: MeditationScheduleConfirmation): Promise<MeditationBookingResponse> {
    try {
      const response = await firstValueFrom(this.http.post<unknown>('/api/schedule', request));
      return validateBookingResponse(response);
    } catch (error) {
      if (error instanceof HttpErrorResponse && isRecord(error.error)) {
        const message = error.error['error'];
        const retryable = error.error['retryable'];
        if (typeof message === 'string' && message.trim()) {
          throw new SchedulingApiError(message.trim(), retryable !== false);
        }
      }
      throw new SchedulingApiError('The calendar service could not complete the booking.', true);
    }
  }
}

function validateResponse(value: unknown): ChatApiResponse {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const route = value['route'];
  const reason = value['reason'];
  const message = value['message'];
  const citationsValue = value['citations'];
  const schedulingProposalValue = value['schedulingProposal'];
  if (
    typeof route !== 'string' ||
    !(CONVERSATION_ROUTES as readonly string[]).includes(route) ||
    typeof reason !== 'string' ||
    !(ROUTING_REASONS as readonly string[]).includes(reason) ||
    typeof message !== 'string' ||
    !message.trim() ||
    !Array.isArray(citationsValue) ||
    !(schedulingProposalValue === null || isRecord(schedulingProposalValue))
  ) {
    throw invalidResponse();
  }
  const citations = citationsValue.map(validateCitation);
  const schedulingProposal =
    schedulingProposalValue === null ? null : validateSchedulingProposal(schedulingProposalValue);
  if (route !== 'IN_SCOPE' && citations.length > 0) {
    throw invalidResponse();
  }
  if (route !== 'SCHEDULE' && schedulingProposal !== null) {
    throw invalidResponse();
  }
  return {
    route: route as ChatApiResponse['route'],
    reason: reason as ChatApiResponse['reason'],
    message: message.trim(),
    citations,
    schedulingProposal,
  };
}

function validateSchedulingProposal(value: Record<string, unknown>): MeditationScheduleProposal {
  const proposalId = value['proposalId'];
  const suggestedDate = value['suggestedDate'];
  const suggestedTime = value['suggestedTime'];
  const timezone = value['timezone'];
  const durationMinutes = value['durationMinutes'];
  if (
    typeof proposalId !== 'string' ||
    !proposalId.trim() ||
    typeof suggestedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(suggestedDate) ||
    typeof suggestedTime !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(suggestedTime) ||
    typeof timezone !== 'string' ||
    !timezone.trim() ||
    typeof durationMinutes !== 'number' ||
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > 1_440
  ) {
    throw invalidResponse();
  }
  return { proposalId, suggestedDate, suggestedTime, timezone, durationMinutes };
}

function validateBookingResponse(value: unknown): MeditationBookingResponse {
  if (!isRecord(value)) {
    throw new SchedulingApiError('The calendar server returned an invalid response.', true);
  }
  const response = value as Record<string, unknown>;
  if (
    response['success'] !== true ||
    typeof response['bookingUid'] !== 'string' ||
    !response['bookingUid'].trim() ||
    typeof response['date'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(response['date']) ||
    typeof response['time'] !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(response['time']) ||
    typeof response['timezone'] !== 'string' ||
    !response['timezone'].trim() ||
    typeof response['startUtc'] !== 'string' ||
    Number.isNaN(Date.parse(response['startUtc'])) ||
    typeof response['durationMinutes'] !== 'number' ||
    !Number.isSafeInteger(response['durationMinutes']) ||
    response['durationMinutes'] <= 0 ||
    typeof response['message'] !== 'string' ||
    !response['message'].trim()
  ) {
    throw new SchedulingApiError('The calendar server returned an invalid response.', true);
  }
  return response as unknown as MeditationBookingResponse;
}

function validateCitation(value: unknown): ChatCitation {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const canonicalRef = value['canonicalRef'];
  const quote = value['quote'];
  const sourceUrl = value['sourceUrl'];
  if (
    typeof canonicalRef !== 'string' ||
    !/^\d{1,2}\.\d{1,3}$/u.test(canonicalRef) ||
    typeof quote !== 'string' ||
    !quote.trim() ||
    quote.length > 4_000 ||
    typeof sourceUrl !== 'string' ||
    !isTrustedWikisourceUrl(sourceUrl)
  ) {
    throw invalidResponse();
  }
  return { canonicalRef, quote, sourceUrl };
}

function isTrustedWikisourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'en.wikisource.org' &&
      url.pathname.startsWith('/wiki/') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): Error {
  return new Error('The chat server returned an invalid response.');
}

export class SchedulingApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SchedulingApiError';
  }
}
