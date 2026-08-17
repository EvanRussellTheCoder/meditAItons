import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ChatStore } from './core/services/chat.store';
import { PreferencesStore } from './core/services/preferences.store';
import { IconComponent, IconName } from './shared/icon/icon';

interface NavigationItem {
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
  readonly exact: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, IconComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closePanels()' },
})
export class App {
  readonly chat = inject(ChatStore);
  readonly preferences = inject(PreferencesStore);
  readonly menuOpen = signal(false);
  readonly settingsOpen = signal(false);

  readonly navigation: readonly NavigationItem[] = [
    { label: 'Journal', path: '/', icon: 'journal', exact: true },
    { label: 'Reflections', path: '/reflections', icon: 'sun', exact: false },
    { label: 'Library', path: '/library', icon: 'book', exact: false },
    { label: 'Profile', path: '/profile', icon: 'profile', exact: false },
  ];

  openMenu(): void {
    this.settingsOpen.set(false);
    this.menuOpen.set(true);
  }

  openSettings(): void {
    this.menuOpen.set(false);
    this.settingsOpen.set(true);
  }

  closePanels(): void {
    this.menuOpen.set(false);
    this.settingsOpen.set(false);
  }

  startNewConversation(): void {
    this.chat.reset();
    this.closePanels();
  }
}
