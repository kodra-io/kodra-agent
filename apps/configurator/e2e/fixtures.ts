import { test as base, expect, type Page } from '@playwright/test';

/**
 * Every test fails if the page requests anything outside its own origin, or if the browser
 * reports a Content Security Policy violation or any other console error.
 */
export const test = base.extend<{ guard: { requests: string[] } }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL ?? 'http://localhost:4174').origin;
      const requests: string[] = [];
      const offsite: string[] = [];
      const errors: string[] = [];
      page.on('request', (req) => {
        const url = req.url();
        requests.push(url);
        if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          offsite.push(url);
        }
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => errors.push(err.message));
      await use({ requests });
      expect(offsite, 'requests outside the page origin').toEqual([]);
      expect(errors, 'console errors, including CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function goToStep(page: Page, name: RegExp | string) {
  await page.getByRole('navigation').getByRole('button', { name }).click();
}

/** Fills the first three steps with a valid compose setup. */
export async function fillBasics(page: Page) {
  await page.getByLabel('Agent name').fill('payments-team-agent');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Model id').fill('some-model');
  await page.getByRole('button', { name: 'Next' }).click();
}

export function connectorCard(page: Page, id: string) {
  return page.locator(`article[data-connector="${id}"]`);
}

export async function enableConnector(page: Page, id: string, name: string) {
  await connectorCard(page, id)
    .getByRole('switch', { name: `Enable ${name}` })
    .click();
}
