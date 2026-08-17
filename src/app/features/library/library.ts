import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { LibraryPassage, StoicTheme } from '../../core/models/library.models';
import { IconComponent } from '../../shared/icon/icon';

const PASSAGES: readonly LibraryPassage[] = [
  {
    id: 1,
    book: 'Meditations, 4.3',
    theme: 'Control',
    text: 'People try to get away from it all—to the country, to the beach, to the mountains. You can get away from it anytime you like, by going within.',
  },
  {
    id: 2,
    book: 'Meditations, 5.1',
    theme: 'Courage',
    text: 'At dawn, when you have trouble getting out of bed, tell yourself: I have to go to work—as a human being.',
  },
  {
    id: 3,
    book: 'Meditations, 7.54',
    theme: 'Presence',
    text: 'Everywhere, at each moment, you have the option to accept this event with humility and to treat this person as they should be treated.',
  },
  {
    id: 4,
    book: 'Meditations, 8.48',
    theme: 'Control',
    text: 'The mind without passions is a fortress. No place is more secure. Once we take refuge there we are safe forever.',
  },
  {
    id: 5,
    book: 'Meditations, 10.16',
    theme: 'Character',
    text: 'Waste no more time arguing about what a good man should be. Be one.',
  },
  {
    id: 6,
    book: 'Meditations, 12.1',
    theme: 'Presence',
    text: 'If you can embrace this gift now, and live as you have lived the rest of your life, you can spend the time that remains in peace.',
  },
];

@Component({
  selector: 'app-library',
  imports: [IconComponent],
  templateUrl: './library.html',
  styleUrl: './library.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryComponent {
  readonly themes: readonly ('All' | StoicTheme)[] = [
    'All',
    'Control',
    'Courage',
    'Presence',
    'Character',
  ];
  readonly search = signal('');
  readonly activeTheme = signal<'All' | StoicTheme>('All');
  readonly bookmarked = signal<ReadonlySet<number>>(new Set([5]));

  readonly passages = computed(() => {
    const term = this.search().trim().toLowerCase();
    const theme = this.activeTheme();
    return PASSAGES.filter(
      (passage) =>
        (theme === 'All' || passage.theme === theme) &&
        (!term || `${passage.text} ${passage.book} ${passage.theme}`.toLowerCase().includes(term)),
    );
  });

  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  toggleBookmark(id: number): void {
    this.bookmarked.update((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
}
