import { AxeBuilder } from '@axe-core/playwright';
import { expect, HOSTILE, signIn, test, TOKEN } from './fixtures.ts';

test('asks for the token, refuses a wrong one, and signs in', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await page.getByLabel('Console token').fill('not-it');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That token is not right.');

  await page.getByLabel('Console token').fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByText('anthropic/claude-sonnet-5-5')).toBeVisible();
  await expect(page.getByText('2 h 3 min')).toBeVisible();
  const connectors = page.getByRole('listitem').filter({ hasText: 'Kubernetes' });
  await expect(connectors).toContainText('Not available');
  expect(api).toContain('POST login');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('shows why a connector is not available, and how to fix it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Connectors' }).click();
  await expect(page).toHaveURL(/\/connectors$/);
  const kube = page.getByRole('article').filter({ hasText: 'Kubernetes' });
  await expect(kube).toContainText('missing Kubernetes kubeconfig');
  await expect(kube).toContainText('copy it to secrets/kubeconfig');
  const gitlab = page.getByRole('article').filter({ hasText: 'GitLab' });
  await expect(gitlab).toContainText('list_merge_requests');
  await expect(gitlab).toContainText('project_id must be one of: jordan-kodra/terraform');
});

test('filters activity on the server', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('cell', { name: 'kubernetes/resources_scale' })).toBeVisible();
  await page.getByLabel('Decision').selectOption('blocked');
  await expect.poll(() => api.some((a) => a.includes('activity?decision=blocked'))).toBe(true);
});

test('shows tool and alert text as text, never as markup', async ({ page, guard }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Investigations' }).click();
  await expect(page.getByText(HOSTILE, { exact: false })).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(0);
  expect(guard.requests.some((r) => r.includes('evil.example'))).toBe(false);
});

test('shows usage with the estimated cost and where the price comes from', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByText('Estimated cost: $0.1406')).toBeVisible();
  await expect(page.getByText('66% of input tokens came from the cache.')).toBeVisible();
  await expect(page.getByText('list prices as of 2026-09-25')).toBeVisible();
});

test('lists approvals and their outcome, with nothing to click', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByText('No decision recorded')).toBeVisible();
  await expect(page.getByText('approved by U-OMAR')).toBeVisible();
  await expect(page.locator('main').getByRole('button', { name: /approve|deny/i })).toHaveCount(0);
});

test('works in Arabic, right to left', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Switch to Arabic' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1, name: 'نظرة عامة' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'الاستهلاك' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'الاستهلاك' })).toBeVisible();
});

test('has no accessibility violations', async ({ page }) => {
  await signIn(page);
  for (const name of ['Overview', 'Connectors', 'Activity', 'Usage', 'Approvals']) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${name}: ${v.id}`)).toEqual([]);
  }
});

test('fits a phone screen @mobile', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Activity' }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
