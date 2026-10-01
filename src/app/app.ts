import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
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
  host: { '(document:keydown.escape)': 'onEscape($event)' },
})
export class App {
  readonly chat = inject(ChatStore);
  readonly preferences = inject(PreferencesStore);
  readonly menuOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly panelOpen = computed(() => this.menuOpen() || this.settingsOpen());
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly pageViewport = viewChild<ElementRef<HTMLElement>>('pageViewport');
  private readonly menuTrigger = viewChild.required<ElementRef<HTMLButtonElement>>('menuTrigger');
  private readonly settingsTrigger =
    viewChild.required<ElementRef<HTMLButtonElement>>('settingsTrigger');
  private readonly menuPanel = viewChild<ElementRef<HTMLElement>>('menuPanel');
  private readonly settingsPanel = viewChild<ElementRef<HTMLElement>>('settingsPanel');
  private restoreFocusTo: HTMLElement | null = null;

  readonly navigation: readonly NavigationItem[] = [
    { label: 'Journal', path: '/', icon: 'journal', exact: true },
    { label: 'Reflections', path: '/reflections', icon: 'sun', exact: false },
    { label: 'Library', path: '/library', icon: 'book', exact: false },
    { label: 'Profile', path: '/profile', icon: 'profile', exact: false },
  ];

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        const viewport = this.pageViewport()?.nativeElement;
        if (viewport) {
          viewport.scrollTop = 0;
        }
      });

    effect((onCleanup) => {
      if (!this.panelOpen()) {
        return;
      }

      const previousOverflow = this.document.body.style.overflow;
      this.document.body.style.overflow = 'hidden';
      onCleanup(() => {
        this.document.body.style.overflow = previousOverflow;
      });
    });
  }

  openMenu(): void {
    this.restoreFocusTo = this.menuTrigger().nativeElement;
    this.settingsOpen.set(false);
    this.menuOpen.set(true);
    this.focusPanel('menu');
  }

  openSettings(): void {
    this.restoreFocusTo = this.settingsTrigger().nativeElement;
    this.menuOpen.set(false);
    this.settingsOpen.set(true);
    this.focusPanel('settings');
  }

  closePanels(): void {
    if (!this.panelOpen()) {
      return;
    }

    const restoreTarget = this.restoreFocusTo;
    this.restoreFocusTo = null;
    this.menuOpen.set(false);
    this.settingsOpen.set(false);
    afterNextRender(
      () => {
        if (!this.panelOpen() && restoreTarget?.isConnected) {
          restoreTarget.focus();
        }
      },
      { injector: this.injector },
    );
  }

  onEscape(event: Event): void {
    if (!this.panelOpen()) {
      return;
    }

    event.preventDefault();
    this.closePanels();
  }

  onPanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }

    const panel = this.activePanel();
    if (!panel) {
      return;
    }

    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const active = this.document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  startNewConversation(): void {
    this.chat.reset();
    this.closePanels();
  }

  private activePanel(): HTMLElement | null {
    if (this.menuOpen()) {
      return this.menuPanel()?.nativeElement ?? null;
    }
    if (this.settingsOpen()) {
      return this.settingsPanel()?.nativeElement ?? null;
    }
    return null;
  }

  private focusPanel(panel: 'menu' | 'settings'): void {
    afterNextRender(
      () => {
        if (
          (panel === 'menu' && !this.menuOpen()) ||
          (panel === 'settings' && !this.settingsOpen())
        ) {
          return;
        }

        this.activePanel()?.querySelector<HTMLElement>('[data-panel-close]')?.focus();
      },
      { injector: this.injector },
    );
  }
}
