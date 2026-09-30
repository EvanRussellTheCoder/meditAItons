import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatStore } from '../../core/services/chat.store';
import { JournalComponent } from './journal';

describe('Journal guide integration', () => {
  let fixture: ComponentFixture<JournalComponent>;
  let element: HTMLElement;
  let requests: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [JournalComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    requests = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(JournalComponent);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLElement>('.conversation')!.scrollTo = vi.fn();

    // jsdom lacks native dialog methods; browser checks cover the top layer and focus trap.
    const dialog = element.querySelector<HTMLDialogElement>('dialog')!;
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
    await fixture.whenStable();
  });

  afterEach(() => {
    requests.verify();
  });

  function click(selector: string): void {
    element.querySelector<HTMLButtonElement>(selector)!.click();
    fixture.detectChanges();
  }

  function writeDraft(value: string): HTMLTextAreaElement {
    const input = element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return input;
  }

  it('adds a scheduling example to the draft without sending or booking anything', () => {
    const chat = TestBed.inject(ChatStore);
    const messages = chat.messages();
    const input = writeDraft('I have a busy day.');
    click('.guide-trigger');
    click('.guide-example:last-child .example-prompt');

    expect(input.value).toBe(
      'I have a busy day.\n\nHelp me schedule a meditation tomorrow at 7 PM.',
    );
    expect(document.activeElement).toBe(input);
    expect(element.querySelector<HTMLDialogElement>('dialog')!.open).toBe(false);
    expect(chat.messages()).toBe(messages);
    expect(chat.pendingSchedule()).toBeNull();
    requests.expectNone(() => true);
  });

  it('preserves the draft and conversation when the guide is dismissed', () => {
    const chat = TestBed.inject(ChatStore);
    const messages = chat.messages();
    const input = writeDraft('A thought I want to finish.');
    click('.guide-trigger');
    click('.close-guide');

    expect(input.value).toBe('A thought I want to finish.');
    expect(chat.messages()).toBe(messages);
    expect(document.activeElement).toBe(element.querySelector('.guide-trigger'));
    requests.expectNone(() => true);
  });

  it('keeps the guide readable but blocks examples while a booking is in progress', () => {
    TestBed.inject(ChatStore).isScheduling.set(true);
    fixture.detectChanges();
    click('.guide-trigger');

    expect(element.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true);
    const examples = [...element.querySelectorAll<HTMLButtonElement>('.example-prompt')];
    expect(examples.every((button) => button.disabled)).toBe(true);
    examples[0].click();
    expect(element.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    expect(element.querySelector('.guide-footer')!.textContent).toContain(
      'Wait for your current request',
    );
    requests.expectNone(() => true);
  });

  it('updates example availability from the live draft length', () => {
    writeDraft('x'.repeat(590));
    click('.guide-trigger');
    expect(
      [...element.querySelectorAll<HTMLButtonElement>('.example-prompt')].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    click('.return-button');
    writeDraft('');
    click('.guide-trigger');
    expect(
      [...element.querySelectorAll<HTMLButtonElement>('.example-prompt')].every(
        (button) => !button.disabled,
      ),
    ).toBe(true);
  });
});
