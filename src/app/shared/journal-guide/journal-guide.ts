import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent, IconName } from '../icon/icon';

interface GuideExample {
  readonly icon: IconName;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

@Component({
  selector: 'app-journal-guide',
  imports: [IconComponent],
  templateUrl: './journal-guide.html',
  styleUrl: './journal-guide.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JournalGuideComponent {
  readonly examplesDisabled = input(false);
  readonly draftLength = input(0);
  readonly exampleSelected = output<string>();
  readonly isOpen = signal(false);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  readonly examples: readonly GuideExample[] = [
    {
      icon: 'leaf',
      title: 'Talk through what’s on your mind',
      description: 'Explore everyday concerns through a Stoic lens.',
      prompt: 'I’m worrying about things I can’t control. How can I approach this?',
    },
    {
      icon: 'book',
      title: 'Learn from Meditations',
      description: 'Explore an idea, then follow the passage references.',
      prompt: 'What did Marcus write about anger?',
    },
    {
      icon: 'calendar',
      title: 'Set aside time to meditate',
      description: 'Review the details and confirm before a session is booked.',
      prompt: 'Help me schedule a meditation tomorrow at 7 PM.',
    },
  ];

  readonly exampleHint = computed(() => {
    if (this.examplesDisabled()) {
      return 'Wait for your current request to finish before adding an example.';
    }
    if (this.examples.some((example) => !this.canInsert(example.prompt))) {
      return 'Your draft is nearly full. Shorten it to add an example.';
    }
    return this.draftLength()
      ? 'Examples are added after your draft for you to edit.'
      : 'Examples fill your message for you to edit.';
  });

  open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal();
      this.isOpen.set(true);
    }
  }

  close(): void {
    this.dialog().nativeElement.close();
    this.isOpen.set(false);
    this.trigger().nativeElement.focus();
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = this.dialog().nativeElement;
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    const dialog = this.dialog().nativeElement;
    if (event.target !== dialog) {
      return;
    }
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      this.close();
    }
  }

  canInsert(prompt: string): boolean {
    const length = this.draftLength();
    return !this.examplesDisabled() && length + (length ? 2 : 0) + prompt.length <= 600;
  }

  selectExample(prompt: string): void {
    if (!this.canInsert(prompt)) {
      return;
    }
    this.close();
    this.exampleSelected.emit(prompt);
  }
}
