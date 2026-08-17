import { TestBed } from '@angular/core/testing';
import { ChatMessage } from '../../core/models/chat.models';
import { ChatMessageComponent } from './chat-message';

describe('ChatMessageComponent', () => {
  beforeEach(() => localStorage.clear());

  it('renders the exact cited passage in an italic blockquote with its source link', () => {
    TestBed.configureTestingModule({ imports: [ChatMessageComponent] });
    const fixture = TestBed.createComponent(ChatMessageComponent);
    const message: ChatMessage = {
      id: 'grounded-answer',
      author: 'marcus',
      content: 'Attend to the present task. Meditations 8.36',
      createdAt: new Date('2026-08-11T12:00:00Z'),
      route: 'IN_SCOPE',
      citations: [
        {
          canonicalRef: '8.36',
          quote: 'Do not disturb thyself by thinking of the whole of thy life.',
          sourceUrl: 'https://en.wikisource.org/wiki/Meditations/Book_VIII',
        },
      ],
    };

    fixture.componentRef.setInput('message', message);
    fixture.detectChanges();

    const quote = fixture.nativeElement.querySelector('blockquote em') as HTMLElement | null;
    const link = fixture.nativeElement.querySelector('figcaption a') as HTMLAnchorElement | null;
    expect(quote?.textContent?.trim()).toBe(message.citations?.[0].quote);
    expect(link?.textContent?.trim()).toBe('— Meditations 8.36');
    expect(link?.href).toBe('https://en.wikisource.org/wiki/Meditations/Book_VIII');
    expect(link?.rel).toBe('noopener noreferrer');
  });
});
