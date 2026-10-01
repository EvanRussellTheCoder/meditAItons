import { expect, Page, test } from '@playwright/test';

const viewports = [
  { name: 'small phone', width: 320, height: 568 },
  { name: 'compact phone', width: 375, height: 667 },
  { name: 'standard phone', width: 390, height: 844 },
  { name: 'large phone', width: 430, height: 932 },
  { name: 'phone landscape', width: 844, height: 390 },
] as const;

const routes = [
  { path: '/', selector: '.journal-page' },
  { path: '/reflections', selector: '#reflection-title' },
  { path: '/library', selector: '#library-title' },
  { path: '/profile', selector: '#profile-title' },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name} renders every route without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);

    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.locator(route.selector)).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      expect(dimensions.clientWidth).toBe(dimensions.viewportWidth);
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    }
  });
}

for (const viewport of [
  { name: 'small phone', width: 320, height: 568 },
  { name: 'standard phone', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'keyboard-height phone', width: 390, height: 320 },
] as const) {
  test(`Journal keeps the composer visible on a ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await settleAnimations(page, '.journal-page');

    const layout = await page.evaluate(() => {
      const pageViewport = document.querySelector<HTMLElement>('.page-viewport')!;
      const conversation = document.querySelector<HTMLElement>('.conversation')!;
      const composer = document.querySelector<HTMLElement>('.composer-wrap')!;
      const pageBounds = pageViewport.getBoundingClientRect();
      const conversationBounds = conversation.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      return {
        pageClientHeight: pageViewport.clientHeight,
        pageScrollHeight: pageViewport.scrollHeight,
        pageTop: pageBounds.top,
        pageBottom: pageBounds.bottom,
        conversationHeight: conversationBounds.height,
        conversationOverflow: getComputedStyle(conversation).overflowY,
        composerTop: composerBounds.top,
        composerBottom: composerBounds.bottom,
      };
    });

    expect(layout.pageScrollHeight).toBeLessThanOrEqual(layout.pageClientHeight + 1);
    expect(layout.conversationHeight).toBeGreaterThan(15);
    expect(layout.conversationOverflow).toBe('auto');
    expect(layout.composerTop).toBeGreaterThanOrEqual(layout.pageTop);
    expect(layout.composerBottom).toBeLessThanOrEqual(layout.pageBottom + 1);
  });
}

test('route navigation resets the custom scrolling viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/library');
  const viewport = page.locator('.page-viewport');
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.locator('.bottom-nav').getByRole('link', { name: 'Profile' }).click();

  await expect(page).toHaveURL(/\/profile$/u);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator('#profile-title')).toBeVisible();
});

test('primary mobile controls meet the 44px touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await expectMinimumTarget(page, '.wordmark, [aria-label="Send message"]');

  await page.goto('/library');
  await expectMinimumTarget(page, '.themes button, .passage-topline button');

  await page.goto('/reflections');
  await expectMinimumTarget(page, '.writing-actions button');

  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        route: 'SCHEDULE',
        reason: 'MEDITATION_SCHEDULING',
        message: 'I prepared a meditation time for your review.',
        citations: [],
        schedulingProposal: {
          proposalId: 'responsive-test-proposal',
          suggestedDate: '2026-10-06',
          suggestedTime: '19:00',
          timezone: 'America/New_York',
          durationMinutes: 30,
        },
      }),
    });
  });
  await page.goto('/');
  await page.getByLabel('Write to Marcus Aurelius').fill('Schedule meditation Tuesday at 7 PM.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.schedule-card')).toBeVisible();
  await expectMinimumTarget(page, '.schedule-card input, .schedule-card footer button');
});

test('mobile supporting text stays legible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await expectMinimumFontSize(page, '.bottom-nav a, .disclaimer', 12);
  await expectContrast(page, '.disclaimer', '#111310', 4.5);

  await page.goto('/library');
  await expectMinimumFontSize(page, '.eyebrow, .themes button, .passage-topline > span', 12);
  await expectPseudoContrast(page, '.search-field input', '::placeholder', '#181a16', 4.5);

  await page.goto('/reflections');
  await expectMinimumFontSize(page, '.prompt-card small, .writing-actions span', 12);
  await expectContrast(page, '.writing-actions span', '#0e100d', 4.5);
});

test('mobile panels trap focus, lock the background, and honor safe-area tokens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewportMeta).toContain('viewport-fit=cover');
  expect(viewportMeta).toContain('interactive-widget=resizes-content');

  const topbar = page.locator('.topbar');
  const safeAreaCss = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
      .join('\n'),
  );
  expect(safeAreaCss).toContain('var(--safe-area-top)');
  expect(safeAreaCss).toContain('var(--safe-area-right)');
  expect(safeAreaCss).toContain('var(--safe-area-bottom)');
  expect(safeAreaCss).toContain('var(--safe-area-left)');

  const trigger = page.getByRole('button', { name: 'Open menu' });
  await trigger.click();
  const panel = page.locator('.menu-panel');
  const close = page.getByRole('button', { name: 'Close menu' });
  const last = page.getByRole('button', { name: 'Begin a new conversation' });
  await expect(close).toBeFocused();
  await expect(topbar).toHaveAttribute('inert', '');
  await expect(page.locator('.page-viewport')).toHaveAttribute('inert', '');
  await expect(page.locator('.bottom-nav')).toHaveAttribute('inert', '');
  expect(await page.locator('body').evaluate((element) => element.style.overflow)).toBe('hidden');
  expect(
    await page.locator('.page-viewport').evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('hidden');
  expect(await panel.evaluate((element) => getComputedStyle(element).overscrollBehavior)).toBe(
    'contain',
  );

  await last.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.locator('body').evaluate((element) => element.style.overflow)).toBe('');
});

async function expectMinimumTarget(page: Page, selector: string): Promise<void> {
  const targets = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        label: element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName,
        width: bounds.width,
        height: bounds.height,
      };
    }),
  );
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(43.5);
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(43.5);
  }
}

async function settleAnimations(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

async function expectMinimumFontSize(page: Page, selector: string, minimum: number): Promise<void> {
  const sizes = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent?.trim() || element.tagName,
      size: Number.parseFloat(getComputedStyle(element).fontSize),
    })),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const value of sizes) {
    expect(value.size, `${value.text} font size`).toBeGreaterThanOrEqual(minimum);
  }
}

async function expectContrast(
  page: Page,
  selector: string,
  background: string,
  minimum: number,
): Promise<void> {
  const color = await page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(minimum);
}

async function expectPseudoContrast(
  page: Page,
  selector: string,
  pseudo: string,
  background: string,
  minimum: number,
): Promise<void> {
  const color = await page
    .locator(selector)
    .evaluate((element, pseudoElement) => getComputedStyle(element, pseudoElement).color, pseudo);
  expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(minimum);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(parseColor(foreground));
  const backgroundLuminance = luminance(parseColor(background));
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function parseColor(color: string): readonly [number, number, number] {
  if (color.startsWith('#')) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
    ];
  }
  const channels = color
    .match(/[\d.]+/gu)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`Unsupported color: ${color}`);
  }
  return channels as [number, number, number];
}

function luminance([red, green, blue]: readonly [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
