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
});
