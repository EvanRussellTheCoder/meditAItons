import { TestBed } from '@angular/core/testing';
import { SchedulingCardComponent } from './scheduling-card';

describe('SchedulingCardComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SchedulingCardComponent],
    }).compileComponents();
  });

  it('shows explicit consent language and emits edited attendee details on confirmation', () => {
    const fixture = TestBed.createComponent(SchedulingCardComponent);
    fixture.componentRef.setInput('proposal', {
      proposalId: 'proposal-1',
      suggestedDate: '2026-08-18',
      suggestedTime: '19:00',
      timezone: 'America/New_York',
      durationMinutes: 30,
    });
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const confirmed = vi.fn();
    component.confirmed.subscribe(confirmed);
    component.attendeeName.set('Test User');
    component.attendeeEmail.set('test@example.com');

    component.submit({ reportValidity: () => true } as HTMLFormElement);

    expect(fixture.nativeElement.textContent).toContain('Nothing will be booked until you confirm');
    expect(confirmed).toHaveBeenCalledWith({
      date: '2026-08-18',
      time: '19:00',
      timezone: 'America/New_York',
      attendeeName: 'Test User',
      attendeeEmail: 'test@example.com',
    });
  });

  it('does not emit another confirmation when the booking outcome is uncertain', () => {
    const fixture = TestBed.createComponent(SchedulingCardComponent);
    fixture.componentRef.setInput('proposal', {
      proposalId: 'proposal-1',
      suggestedDate: '2026-08-18',
      suggestedTime: '19:00',
      timezone: 'America/New_York',
      durationMinutes: 30,
    });
    fixture.componentRef.setInput('retryable', false);
    fixture.detectChanges();
    const confirmed = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);

    fixture.componentInstance.submit({ reportValidity: () => true } as HTMLFormElement);

    expect(confirmed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Check Cal.com');
  });
});
