import { TestBed } from '@angular/core/testing';
import { JournalGuideComponent } from './journal-guide';

describe('JournalGuideComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [JournalGuideComponent] }).compileComponents();
  });

  function createGuide() {
    const fixture = TestBed.createComponent(JournalGuideComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog: HTMLDialogElement = fixture.nativeElement.querySelector('dialog');
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.guide-trigger');

    // jsdom lacks the native dialog methods. Match their open state, initial
    // focus, and asynchronous close event; browser validation covers modality.
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
      dialog.querySelector<HTMLButtonElement>('[autofocus]')?.focus();
    });
    dialog.close = vi.fn(() => {
      if (!dialog.open) {
        return;
      }
      dialog.open = false;
      queueMicrotask(() => dialog.dispatchEvent(new Event('close')));
    });

    return { fixture, component, dialog, trigger };
  }

  it('starts closed and opens the labelled guide from its trigger', () => {
    const { fixture, component, dialog, trigger } = createGuide();

    expect(dialog.open).toBe(false);
    expect(component.isOpen()).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    fixture.detectChanges();

    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(component.isOpen()).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('journal-guide-title');
    expect(dialog.querySelector('#journal-guide-title')?.textContent).toBe(
      'A guide to your journal',
    );
    expect(document.activeElement).toBe(dialog.querySelector('.close-guide'));
    expect(dialog.querySelectorAll('.example-prompt')).toHaveLength(3);
  });

  it.each([
    ['close button', '.close-guide'],
    ['Return to journal button', '.return-button'],
  ])('closes via the %s and restores trigger focus', async (_label, selector) => {
    const { fixture, component, dialog, trigger } = createGuide();
    trigger.click();

    dialog.querySelector<HTMLButtonElement>(selector)!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(dialog.open).toBe(false);
    expect(component.isOpen()).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    expect(dialog.open).toBe(true);
  });

  it('handles an Escape cancel event and returns focus to the trigger', async () => {
    const { component, dialog, trigger } = createGuide();
    trigger.click();
    const cancel = new Event('cancel', { cancelable: true });

    dialog.dispatchEvent(cancel);
    await Promise.resolve();

    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(component.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('emits the chosen example after closing the guide', () => {
    const { component, dialog, trigger } = createGuide();
    const selected = vi.fn(() => expect(dialog.open).toBe(false));
    component.exampleSelected.subscribe(selected);
    trigger.click();

    dialog.querySelector<HTMLButtonElement>('.example-prompt')!.click();

    expect(selected).toHaveBeenCalledExactlyOnceWith(component.examples[0].prompt);
    expect(component.isOpen()).toBe(false);
  });

  it('wraps Tab and Shift+Tab inside the guide, including when examples are disabled', () => {
    const { fixture, dialog, trigger } = createGuide();
    fixture.componentRef.setInput('examplesDisabled', true);
    fixture.detectChanges();
    trigger.click();
    const first = dialog.querySelector<HTMLButtonElement>('.close-guide')!;
    const last = dialog.querySelector<HTMLButtonElement>('.return-button')!;

    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(first);
  });

  it('dismisses backdrop clicks but leaves clicks inside the dialog alone', () => {
    const { dialog, trigger } = createGuide();
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 500,
      top: 100,
      bottom: 600,
      width: 400,
      height: 500,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    trigger.click();

    dialog.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 200, bubbles: true }));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 200, bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal composer focus when the native close event arrives after selection', async () => {
    const { fixture, component, dialog, trigger } = createGuide();
    const composer = document.createElement('textarea');
    fixture.nativeElement.appendChild(composer);
    component.exampleSelected.subscribe(() => composer.focus());
    trigger.click();

    dialog.querySelector<HTMLButtonElement>('.example-prompt')!.click();
    expect(document.activeElement).toBe(composer);
    await Promise.resolve();

    expect(document.activeElement).toBe(composer);
    expect(component.isOpen()).toBe(false);
  });

  it('disables and blocks all examples while a request is in progress', () => {
    const { fixture, component, dialog, trigger } = createGuide();
    fixture.componentRef.setInput('examplesDisabled', true);
    fixture.detectChanges();
    const selected = vi.fn();
    component.exampleSelected.subscribe(selected);
    trigger.click();

    for (const button of dialog.querySelectorAll<HTMLButtonElement>('.example-prompt')) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    component.selectExample(component.examples[0].prompt);

    expect(selected).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('#guide-example-hint')?.textContent).toContain(
      'Wait for your current request to finish',
    );
  });

  it('blocks examples that would overflow the draft and explains why', () => {
    const { fixture, component, dialog, trigger } = createGuide();
    fixture.componentRef.setInput('draftLength', 590);
    fixture.detectChanges();
    const selected = vi.fn();
    component.exampleSelected.subscribe(selected);
    trigger.click();

    for (const button of dialog.querySelectorAll<HTMLButtonElement>('.example-prompt')) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    component.selectExample(component.examples[0].prompt);

    expect(selected).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('#guide-example-hint')?.textContent).toContain('Shorten it');
  });

  it('allows an example that exactly fits while disabling longer examples', () => {
    const { fixture, component, dialog, trigger } = createGuide();
    const shortest = component.examples[1];
    fixture.componentRef.setInput('draftLength', 600 - shortest.prompt.length - 2);
    fixture.detectChanges();
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('.example-prompt');
    const selected = vi.fn();
    component.exampleSelected.subscribe(selected);
    trigger.click();

    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
    buttons[1].click();

    expect(selected).toHaveBeenCalledExactlyOnceWith(shortest.prompt);
    expect(dialog.open).toBe(false);
  });

  it('explains that examples append to an existing draft', () => {
    const { fixture, dialog } = createGuide();
    fixture.componentRef.setInput('draftLength', 20);
    fixture.detectChanges();

    expect(dialog.querySelector('#guide-example-hint')?.textContent).toContain(
      'added after your draft',
    );
  });
});
