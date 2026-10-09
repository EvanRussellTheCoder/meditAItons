import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import type {
  MeditationScheduleConfirmation,
  MeditationScheduleProposal,
} from '../../core/models/chat.models';
import { IconComponent } from '../icon/icon';

@Component({
  selector: 'app-scheduling-card',
  imports: [IconComponent],
  templateUrl: './scheduling-card.html',
  styleUrl: './scheduling-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulingCardComponent {
  readonly proposal = input.required<MeditationScheduleProposal>();
  readonly submitting = input(false);
  readonly error = input<string | null>(null);
  readonly retryable = input(true);
  readonly confirmed = output<Omit<MeditationScheduleConfirmation, 'proposalId'>>();
  readonly cancelled = output<void>();

  readonly date = signal('');
  readonly time = signal('');
  readonly timezone = signal('');
  readonly attendeeName = signal('');
  readonly attendeeEmail = signal('');

  private activeProposalId = '';

  constructor() {
    effect(() => {
      const proposal = this.proposal();
      if (proposal.proposalId !== this.activeProposalId) {
        this.activeProposalId = proposal.proposalId;
        this.date.set(proposal.suggestedDate);
        this.time.set(proposal.suggestedTime);
        this.timezone.set(proposal.timezone);
        this.attendeeName.set('');
        this.attendeeEmail.set('');
      }
    });
  }

  update(
    field: 'date' | 'time' | 'timezone' | 'attendeeName' | 'attendeeEmail',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).value;
    this[field].set(value);
  }

  submit(form: HTMLFormElement): void {
    if (!form.reportValidity() || this.submitting() || !this.retryable()) {
      return;
    }
    this.confirmed.emit({
      date: this.date(),
      time: this.time(),
      timezone: this.timezone().trim(),
      attendeeName: this.attendeeName().trim(),
      attendeeEmail: this.attendeeEmail().trim(),
    });
  }
}
