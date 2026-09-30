import { TestBed } from '@angular/core/testing';
import { ChatComposerComponent } from './chat-composer';

describe('ChatComposerComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatComposerComponent] }).compileComponents();
  });

  it('emits a trimmed message and clears the draft', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    const component = fixture.componentInstance;
    const submitted = vi.fn();
    component.submitted.subscribe(submitted);
    component.draft.set('  Focus on today  ');

    component.submit();

    expect(submitted).toHaveBeenCalledWith('Focus on today');
    expect(component.draft()).toBe('');
  });

  it('does not emit while disabled', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    fixture.componentRef.setInput('disabled', true);
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    fixture.componentInstance.draft.set('A question');

    fixture.componentInstance.submit();

    expect(submitted).not.toHaveBeenCalled();
  });

  it('inserts an example without submitting and focuses the resized textarea', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const submitted = vi.fn();
    component.submitted.subscribe(submitted);
    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 80 });

    expect(component.insertExample('Help me reflect on today.')).toBe(true);

    expect(component.draft()).toBe('Help me reflect on today.');
    expect(textarea.value).toBe('Help me reflect on today.');
    expect(textarea.style.height).toBe('80px');
    expect(document.activeElement).toBe(textarea);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('preserves an existing draft when appending an example', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.draft.set('  My unfinished thought  ');

    expect(component.insertExample('What is within my control?')).toBe(true);

    expect(component.draft()).toBe('  My unfinished thought  \n\nWhat is within my control?');
    expect(fixture.nativeElement.querySelector('textarea').value).toBe(component.draft());
  });

  it('does not insert an example while disabled', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    fixture.componentRef.setInput('disabled', true);
    fixture.componentInstance.draft.set('My existing draft');
    fixture.detectChanges();

    expect(fixture.componentInstance.insertExample('An example')).toBe(false);

    expect(fixture.componentInstance.draft()).toBe('My existing draft');
    expect(fixture.nativeElement.querySelector('textarea').value).toBe('My existing draft');
  });

  it('preserves the draft and textarea when an example would exceed the character limit', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    const component = fixture.componentInstance;
    component.draft.set('a'.repeat(598));
    fixture.detectChanges();

    expect(component.insertExample('b')).toBe(false);

    expect(component.draft()).toBe('a'.repeat(598));
    expect(fixture.nativeElement.querySelector('textarea').value).toBe('a'.repeat(598));
  });

  it('accepts an example when the combined draft exactly meets the character limit', () => {
    const fixture = TestBed.createComponent(ChatComposerComponent);
    const component = fixture.componentInstance;
    component.draft.set('a'.repeat(597));
    fixture.detectChanges();

    expect(component.insertExample('b')).toBe(true);

    expect(component.draft()).toBe(`${'a'.repeat(597)}\n\nb`);
    expect(component.draft().length).toBe(600);
  });
});
