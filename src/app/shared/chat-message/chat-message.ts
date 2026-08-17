import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { ChatMessage } from '../../core/models/chat.models';
import { PreferencesStore } from '../../core/services/preferences.store';

@Component({
  selector: 'app-chat-message',
  imports: [DatePipe],
  templateUrl: './chat-message.html',
  styleUrl: './chat-message.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-user]': "message().author === 'user'",
    '[class.is-compact]': 'preferences.compactMessages()',
  },
})
export class ChatMessageComponent {
  readonly message = input.required<ChatMessage>();
  readonly preferences = inject(PreferencesStore);
}
