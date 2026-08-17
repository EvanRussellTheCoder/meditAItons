export type StoicTheme = 'Control' | 'Courage' | 'Presence' | 'Character';

export interface LibraryPassage {
  readonly id: number;
  readonly book: string;
  readonly text: string;
  readonly theme: StoicTheme;
}
