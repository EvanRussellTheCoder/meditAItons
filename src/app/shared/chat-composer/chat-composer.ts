import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

@Component({
  selector: 'app-chat-composer',
  imports: [IconComponent],
  templateUrl: './chat-composer.html',
  styleUrl: './chat-composer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComposerComponent {
  readonly disabled = input(false);
  readonly submitted = output<string>();
  readonly draft = signal('');
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  onInput(event: Event): void {
    const element = event.target as HTMLTextAreaElement;
    this.draft.set(element.value.slice(0, 600));
    this.resize(element);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  submit(): void {
    const message = this.draft().trim();
    if (!message || this.disabled()) {
      return;
    }

    this.submitted.emit(message);
    this.draft.set('');

    const textarea = this.textarea()?.nativeElement;
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
      textarea.focus();
    }
  }

  private resize(element: HTMLTextAreaElement): void {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }
}
