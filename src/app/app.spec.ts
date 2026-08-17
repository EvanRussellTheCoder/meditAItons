import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
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
});
