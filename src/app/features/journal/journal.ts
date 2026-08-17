import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { ChatStore } from '../../core/services/chat.store';
import { PreferencesStore } from '../../core/services/preferences.store';
import { ChatComposerComponent } from '../../shared/chat-composer/chat-composer';
import { ChatMessageComponent } from '../../shared/chat-message/chat-message';
import { SchedulingCardComponent } from '../../shared/scheduling-card/scheduling-card';

@Component({
  selector: 'app-journal',
  imports: [DatePipe, ChatComposerComponent, ChatMessageComponent, SchedulingCardComponent],
  templateUrl: './journal.html',
  styleUrl: './journal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JournalComponent {
  readonly chat = inject(ChatStore);
  readonly today = new Date();
  private readonly preferences = inject(PreferencesStore);
  private readonly conversation = viewChild<ElementRef<HTMLElement>>('conversation');

  constructor() {
    effect(() => {
      this.chat.messageCount();
      this.chat.isResponding();
      this.chat.pendingSchedule();
      this.chat.isScheduling();

      queueMicrotask(() => {
        const conversation = this.conversation()?.nativeElement;
        conversation?.scrollTo({
          top: conversation.scrollHeight,
          behavior: this.preferences.reducedMotion() ? 'auto' : 'smooth',
        });
      });
    });
  }
}
