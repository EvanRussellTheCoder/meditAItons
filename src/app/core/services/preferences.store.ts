import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';

interface Preferences {
  readonly showTimestamps: boolean;
  readonly compactMessages: boolean;
  readonly reducedMotion: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  showTimestamps: true,
  compactMessages: false,
  reducedMotion: false,
};

@Injectable({ providedIn: 'root' })
export class PreferencesStore {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly document = inject(DOCUMENT);
  private readonly storageKey = 'meditations.preferences.v1';

  readonly showTimestamps = signal(DEFAULT_PREFERENCES.showTimestamps);
  readonly compactMessages = signal(DEFAULT_PREFERENCES.compactMessages);
  readonly reducedMotion = signal(DEFAULT_PREFERENCES.reducedMotion);

  constructor() {
    this.restore();

    effect(() => {
      const preferences: Preferences = {
        showTimestamps: this.showTimestamps(),
        compactMessages: this.compactMessages(),
        reducedMotion: this.reducedMotion(),
      };

      this.document.documentElement.classList.toggle('reduce-motion', preferences.reducedMotion);

      if (isPlatformBrowser(this.platformId)) {
        localStorage.setItem(this.storageKey, JSON.stringify(preferences));
      }
    });
  }

  reset(): void {
    this.showTimestamps.set(DEFAULT_PREFERENCES.showTimestamps);
    this.compactMessages.set(DEFAULT_PREFERENCES.compactMessages);
    this.reducedMotion.set(DEFAULT_PREFERENCES.reducedMotion);
  }

  private restore(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        return;
      }

      const preferences = JSON.parse(stored) as Partial<Preferences>;
      this.showTimestamps.set(preferences.showTimestamps ?? DEFAULT_PREFERENCES.showTimestamps);
      this.compactMessages.set(preferences.compactMessages ?? DEFAULT_PREFERENCES.compactMessages);
      this.reducedMotion.set(preferences.reducedMotion ?? DEFAULT_PREFERENCES.reducedMotion);
    } catch {
      localStorage.removeItem(this.storageKey);
    }
  }
}
