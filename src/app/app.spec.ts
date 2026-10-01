import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideRouter(routes)],
    }).compileComponents();
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('creates the application shell', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the Marcus Aurelius wordmark and primary navigation', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.wordmark')?.textContent).toContain('Marcus Aurelius');
    expect(element.querySelectorAll('.bottom-nav a')).toHaveLength(4);
  });

  it('opens and closes the settings panel', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    fixture.componentInstance.openSettings();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.settings-panel')).toBeTruthy();

    fixture.componentInstance.closePanels();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.settings-panel')).toBeNull();
  });

  it('resets the routed viewport when navigation completes', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    fixture.detectChanges();
    await router.navigateByUrl('/library');
    await fixture.whenStable();
    fixture.detectChanges();

    const viewport = fixture.nativeElement.querySelector('.page-viewport') as HTMLElement;
    viewport.scrollTop = 175;

    await router.navigateByUrl('/profile');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(viewport.scrollTop).toBe(0);
    expect(fixture.nativeElement.querySelector('#profile-title')).toBeTruthy();
  });

  it('makes the background inert, traps focus, and restores the menu trigger', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!;

    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const panel = element.querySelector<HTMLElement>('.menu-panel')!;
    const first = panel.querySelector<HTMLButtonElement>('[data-panel-close]')!;
    const last = panel.querySelector<HTMLButtonElement>('.new-conversation')!;
    expect(document.activeElement).toBe(first);
    expect(document.body.style.overflow).toBe('hidden');
    expect(element.querySelector('.topbar')?.hasAttribute('inert')).toBe(true);
    expect(element.querySelector('.page-viewport')?.hasAttribute('inert')).toBe(true);
    expect(element.querySelector('.bottom-nav')?.hasAttribute('inert')).toBe(true);

    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    first.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(element.querySelector('.menu-panel')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(element.querySelector('.topbar')?.hasAttribute('inert')).toBe(false);
  });

  it('closes settings with Escape and restores prior overflow and trigger focus', async () => {
    document.body.style.overflow = 'clip';
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!;

    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.activeElement).toBe(
      element.querySelector<HTMLButtonElement>('[aria-label="Close settings"]'),
    );
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escape);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(escape.defaultPrevented).toBe(true);
    expect(element.querySelector('.settings-panel')).toBeNull();
    expect(document.body.style.overflow).toBe('clip');
    expect(document.activeElement).toBe(trigger);
  });

  it('restores body scrolling if the application is destroyed with a panel open', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!
      .click();
    fixture.detectChanges();
    expect(document.body.style.overflow).toBe('hidden');

    fixture.destroy();

    expect(document.body.style.overflow).toBe('');
  });
});
