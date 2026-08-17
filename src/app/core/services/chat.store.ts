import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import {
  ChatMessage,
  MeditationScheduleConfirmation,
  MeditationScheduleProposal,
  StoredChatMessage,
} from '../models/chat.models';
import { ChatApiClient, SchedulingApiError } from './chat-api.client';

const MAX_API_HISTORY_MESSAGES = 8;
const CONNECTION_ERROR_MESSAGE =
  "I couldn't reach the private Meditations service. Your message was not sent to Pinecone. " +
  'Please make sure the local API is running, then try again.';

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly api = inject(ChatApiClient);
  private readonly storageKey = 'meditations.conversation.v3';
  private messageSequence = 0;
  private activeRequest = 0;

  private readonly _messages = signal<readonly ChatMessage[]>(this.restoreMessages());
  readonly messages = this._messages.asReadonly();
  readonly isResponding = signal(false);
  readonly pendingSchedule = signal<MeditationScheduleProposal | null>(null);
  readonly isScheduling = signal(false);
  readonly schedulingError = signal<string | null>(null);
  readonly schedulingRetryable = signal(true);
  readonly messageCount = computed(() => this._messages().length);

  constructor() {
    effect(() => this.persist(this._messages()));
  }

  send(content: string): void {
    const question = content.trim();
    if (!question || this.isResponding() || this.isScheduling()) {
      return;
    }

    const history = this._messages()
      .slice(-MAX_API_HISTORY_MESSAGES)
      .map(({ author, content: messageContent }) => ({ author, content: messageContent }));
    const requestId = ++this.activeRequest;
    this.pendingSchedule.set(null);
    this.schedulingError.set(null);
    this.schedulingRetryable.set(true);
    this._messages.update((messages) => [
      ...messages,
      this.createMessage('user', question, 'read'),
    ]);
    this.isResponding.set(true);
    void this.requestReply(question, history, requestId);
  }

  reset(): void {
    if (this.isScheduling()) {
      return;
    }
    this.activeRequest += 1;
    this.isResponding.set(false);
    this.pendingSchedule.set(null);
    this.isScheduling.set(false);
    this.schedulingError.set(null);
    this.schedulingRetryable.set(true);
    this._messages.set([this.createMessage('marcus', 'What troubles your mind today?')]);
  }

  confirmSchedule(details: Omit<MeditationScheduleConfirmation, 'proposalId'>): void {
    const proposal = this.pendingSchedule();
    if (!proposal || this.isScheduling()) {
      return;
    }
    this.isScheduling.set(true);
    this.schedulingError.set(null);
    void this.requestBooking({ ...details, proposalId: proposal.proposalId });
  }

  cancelSchedule(): void {
    if (!this.isScheduling()) {
      this.pendingSchedule.set(null);
      this.schedulingError.set(null);
      this.schedulingRetryable.set(true);
    }
  }

  private async requestReply(
    question: string,
    history: readonly { readonly author: ChatMessage['author']; readonly content: string }[],
    requestId: number,
  ): Promise<void> {
    try {
      const response = await this.api.reply({
        message: question,
        history,
        timezone: this.userTimezone(),
      });
      if (requestId !== this.activeRequest) {
        return;
      }
      this._messages.update((messages) => [
        ...messages,
        this.createMessage(
          'marcus',
          response.message,
          undefined,
          new Date(),
          response.route,
          response.citations,
        ),
      ]);
      this.pendingSchedule.set(response.schedulingProposal);
      this.schedulingRetryable.set(true);
    } catch {
      if (requestId !== this.activeRequest) {
        return;
      }
      this._messages.update((messages) => [
        ...messages,
        this.createMessage('marcus', CONNECTION_ERROR_MESSAGE),
      ]);
    } finally {
      if (requestId === this.activeRequest) {
        this.isResponding.set(false);
      }
    }
  }

  private async requestBooking(request: MeditationScheduleConfirmation): Promise<void> {
    try {
      const response = await this.api.schedule(request);
      this.pendingSchedule.set(null);
      this._messages.update((messages) => [
        ...messages,
        this.createMessage('marcus', response.message, undefined, new Date(), 'SCHEDULE'),
      ]);
    } catch (error) {
      this.schedulingError.set(
        error instanceof Error ? error.message : 'The calendar service could not book that time.',
      );
      this.schedulingRetryable.set(error instanceof SchedulingApiError ? error.retryable : true);
    } finally {
      this.isScheduling.set(false);
    }
  }

  private createMessage(
    author: ChatMessage['author'],
    content: string,
    status?: ChatMessage['status'],
    createdAt = new Date(),
    route?: ChatMessage['route'],
    citations?: ChatMessage['citations'],
  ): ChatMessage {
    return {
      id: `${createdAt.getTime()}-${this.messageSequence++}`,
      author,
      content,
      createdAt,
      status,
      ...(route ? { route } : {}),
      ...(citations?.length ? { citations } : {}),
    };
  }

  private restoreMessages(): readonly ChatMessage[] {
    if (!isPlatformBrowser(this.platformId)) {
      return this.seedMessages();
    }

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        return this.seedMessages();
      }

      const messages = JSON.parse(stored) as StoredChatMessage[];
      return messages.map((message) => ({
        ...message,
        createdAt: new Date(message.createdAt),
      }));
    } catch {
      localStorage.removeItem(this.storageKey);
      return this.seedMessages();
    }
  }

  private seedMessages(): readonly ChatMessage[] {
    return [this.createMessage('marcus', 'What troubles your mind today?')];
  }

  private userTimezone(): string {
    if (!isPlatformBrowser(this.platformId)) {
      return 'UTC';
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  private persist(messages: readonly ChatMessage[]): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(this.storageKey, JSON.stringify(messages));
    }
  }
}
