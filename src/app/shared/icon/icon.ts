import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'menu'
  | 'settings'
  | 'journal'
  | 'sun'
  | 'book'
  | 'profile'
  | 'send'
  | 'close'
  | 'sparkle'
  | 'bookmark'
  | 'search'
  | 'chevron'
  | 'leaf'
  | 'quote'
  | 'calendar';

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-hidden]': 'true' },
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @switch (name()) {
        @case ('menu') {
          <path d="M4 6h16M4 12h16M4 18h12" />
        }
        @case ('settings') {
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.8 7l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.61.77 1 1.41 1H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"
          />
        }
        @case ('journal') {
          <path d="M6 3h12a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V3Z" />
          <path d="M8 21a2 2 0 0 1 0-4h12M10 7h6M10 11h5" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"
          />
        }
        @case ('book') {
          <path
            d="M3 5.5A3.5 3.5 0 0 1 6.5 2H11v17H6.5A3.5 3.5 0 0 0 3 22V5.5ZM21 5.5A3.5 3.5 0 0 0 17.5 2H13v17h4.5A3.5 3.5 0 0 1 21 22V5.5Z"
          />
        }
        @case ('profile') {
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
        }
        @case ('send') {
          <path d="m22 2-7 20-4-9-9-4 20-7Z" />
          <path d="M22 2 11 13" />
        }
        @case ('close') {
          <path d="m6 6 12 12M18 6 6 18" />
        }
        @case ('sparkle') {
          <path
            d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8L12 3ZM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15ZM5 3l.7 2.3L8 6l-2.3.7L5 9l-.7-2.3L2 6l2.3-.7L5 3Z"
          />
        }
        @case ('bookmark') {
          <path d="M6 3h12v18l-6-4-6 4V3Z" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        }
        @case ('chevron') {
          <path d="m9 18 6-6-6-6" />
        }
        @case ('leaf') {
          <path d="M20 3C12 3 6 7 6 14c0 2 1 4 3 5 7-2 11-7 11-16Z" />
          <path d="M4 21c3-6 7-9 12-12" />
        }
        @case ('quote') {
          <path
            d="M9 11H4a7 7 0 0 1 7-7v3a4 4 0 0 0-4 4h2v7H3v-7M21 11h-5a7 7 0 0 1 7-7v3a4 4 0 0 0-4 4h2v7h-6v-7"
          />
        }
        @case ('calendar') {
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18M8 14h3M8 17h7" />
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-grid;
      width: 1.5rem;
      height: 1.5rem;
      place-items: center;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
}
