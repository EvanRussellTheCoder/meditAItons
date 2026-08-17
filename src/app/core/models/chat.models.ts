import type { ConversationRoute, RoutingReason } from '../routing/types';

export type MessageAuthor = 'marcus' | 'user';
export type DeliveryStatus = 'sent' | 'read';

export interface ChatCitation {
  readonly canonicalRef: string;
  readonly quote: string;
  readonly sourceUrl: string;
}

export interface MeditationScheduleProposal {
  readonly proposalId: string;
  readonly suggestedDate: string;
  readonly suggestedTime: string;
  readonly timezone: string;
  readonly durationMinutes: number;
}

export interface MeditationScheduleConfirmation {
  readonly proposalId: string;
  readonly date: string;
  readonly time: string;
  readonly timezone: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
}

export interface MeditationBookingResponse {
  readonly success: true;
  readonly bookingUid: string;
  readonly date: string;
  readonly time: string;
  readonly timezone: string;
  readonly startUtc: string;
  readonly durationMinutes: number;
  readonly message: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly author: MessageAuthor;
  readonly content: string;
  readonly createdAt: Date;
  readonly status?: DeliveryStatus;
  readonly route?: ConversationRoute;
  readonly citations?: readonly ChatCitation[];
}

export interface StoredChatMessage extends Omit<ChatMessage, 'createdAt'> {
  readonly createdAt: string;
}

export interface ChatHistoryMessage {
  readonly author: MessageAuthor;
  readonly content: string;
}

export interface ChatApiRequest {
  readonly message: string;
  readonly history: readonly ChatHistoryMessage[];
  readonly timezone: string;
}

export interface ChatApiResponse {
  readonly route: ConversationRoute;
  readonly reason: RoutingReason;
  readonly message: string;
  readonly citations: readonly ChatCitation[];
  readonly schedulingProposal: MeditationScheduleProposal | null;
}
