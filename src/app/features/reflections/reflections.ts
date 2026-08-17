import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { IconComponent } from '../../shared/icon/icon';

interface ReflectionPrompt {
  readonly number: string;
  readonly title: string;
  readonly question: string;
}

@Component({
  selector: 'app-reflections',
  imports: [IconComponent],
  templateUrl: './reflections.html',
  styleUrl: './reflections.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReflectionsComponent {
  readonly prompts: readonly ReflectionPrompt[] = [
    {
      number: 'I',
      title: 'Name what is yours',
      question: 'What in this situation is genuinely within your control?',
    },
    {
      number: 'II',
      title: 'Release the rest',
      question: 'What are you carrying that belongs to chance, time, or another person?',
    },
    {
      number: 'III',
      title: 'Choose the next act',
      question: 'What would courage and good character ask you to do next?',
    },
  ];

  readonly selectedPrompt = signal<ReflectionPrompt>(this.prompts[0]);
  readonly entry = signal('');
  readonly saved = signal(false);

  selectPrompt(prompt: ReflectionPrompt): void {
    this.selectedPrompt.set(prompt);
    this.saved.set(false);
  }

  updateEntry(event: Event): void {
    this.entry.set((event.target as HTMLTextAreaElement).value);
    this.saved.set(false);
  }

  save(): void {
    if (this.entry().trim()) {
      this.saved.set(true);
    }
  }
}
