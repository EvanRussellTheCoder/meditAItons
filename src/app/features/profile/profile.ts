import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChatStore } from '../../core/services/chat.store';
import { PreferencesStore } from '../../core/services/preferences.store';
import { IconComponent } from '../../shared/icon/icon';

@Component({
  selector: 'app-profile',
  imports: [IconComponent],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent {
  readonly chat = inject(ChatStore);
  readonly preferences = inject(PreferencesStore);
}
