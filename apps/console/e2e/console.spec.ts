import { AxeBuilder } from '@axe-core/playwright';
import { APPROVER_TOKEN, CHAT_REQUEST, expect, HOSTILE, signIn, test, TOKEN } from './fixtures.ts';

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
  // A limit every tool shares is shown once.
  await expect(gitlab.getByText('project_id must be one of: jordan-kodra/terraform')).toHaveCount(
    1,
  );
  await expect(gitlab).toContainText('Every tool:');
  const docker = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Docker' }) });
  await expect(docker).toContainText('Used by kodra-agent ship');
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
  await expect(page.getByRole('definition').filter({ hasText: '$0.1406' })).toBeVisible();
  await expect(page.getByText('66% of input tokens came from the cache.')).toBeVisible();
  await expect(page.getByText('list prices as of 2026-09-25')).toBeVisible();
});

test('lists approvals; the shared token sees waiting requests but cannot decide', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByText('Signed in as console.')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByText('No decision recorded')).toBeVisible();
  await expect(page.getByText('approved by U-OMAR')).toBeVisible();
  const waiting = page.getByRole('group', { name: 'Needs approval' });
  await expect(waiting).toHaveCount(2);
  await expect(waiting.first()).toContainText('github/create_pull_request');
  await expect(waiting.first()).toContainText('Waiting for an approver.');
  await expect(page.locator('main').getByRole('button', { name: /approve|deny/i })).toHaveCount(0);
});

test('a console approver approves a waiting request after confirming', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await expect(
    page.getByText('Signed in as console:omar. You can approve changes here.'),
  ).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  const waiting = page.getByRole('group', { name: 'Needs approval' });
  const pr = waiting.filter({ hasText: 'create_pull_request' });
  await pr.getByRole('button', { name: 'Approve' }).click();
  // Nothing is sent until the second, explicit step.
  expect(api.some((a) => a.startsWith('POST approvals/decide'))).toBe(false);
  await expect(pr).toContainText('Run github/create_pull_request now? This changes your system.');
  await pr.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(waiting).toHaveCount(1);
  expect(api).toContain('BODY approvals/decide {"id":"req-2","approve":true}');

  // A request that expired meanwhile says so, and nothing runs.
  await waiting.getByRole('button', { name: 'Approve' }).click();
  await waiting.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(waiting.getByRole('alert')).toHaveText('This request expired. Nothing was run.');
  await expect(waiting.getByRole('button')).toHaveCount(0);
});

test('chats with the agent and shows each step live', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible();
  await page.getByLabel('Message').fill('Why does web keep restarting?');
  await page.getByRole('button', { name: 'Send' }).click();

  const log = page.getByRole('log');
  await expect(log).toContainText('Why does web keep restarting?');
  await expect(log.getByText('kubernetes/pods_log')).toBeVisible();
  await expect(log).toContainText('done');
  const card = log.getByRole('group', { name: 'Needs approval' });
  await expect(card).toContainText('kubernetes/resources_scale');
  // The model's reason is text, never markup.
  await expect(card).toContainText(HOSTILE);
  await expect(page.locator('main img')).toHaveCount(0);
  // The shared token cannot approve.
  await expect(card).toContainText('Waiting for an approver.');
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  await expect(page.getByRole('navigation', { name: 'Conversations' })).toContainText(
    'Why does web keep restarting?',
  );
  expect(api).toContain('BODY chat {"text":"Why does web keep restarting?"}');
});

test('approves a change from the chat, then shows the answer', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Message').fill('Scale web to 2');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByRole('log').getByRole('group', { name: 'Needs approval' });
  await card.getByRole('button', { name: 'Approve' }).click();
  await card.getByRole('button', { name: 'Yes, run it' }).click();

  const log = page.getByRole('log');
  await expect(log).toContainText('approved by console:omar');
  await expect(log).toContainText('Scaled web to 2.');
  await expect(log).toContainText('12,000 tokens in (9,000 from cache), 300 out');
  await page.getByLabel('Message').fill('Thanks');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(api).toContain(`BODY approvals/decide {"id":"${CHAT_REQUEST.id}","approve":true}`);
});

test('denies a change with a reason the agent sees', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Message').fill('Scale web to 2');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByRole('log').getByRole('group', { name: 'Needs approval' });
  await card.getByRole('button', { name: 'Deny' }).click();
  await card.getByLabel('Reason (optional, the agent sees it)').fill('Not during the release');
  await card.getByRole('button', { name: 'Deny the change' }).click();

  const log = page.getByRole('log');
  await expect(log).toContainText('denied by console:omar');
  await expect(log).toContainText('Not during the release');
  await expect(log).toContainText('I did not scale web.');
  expect(api).toContain(
    `BODY approvals/decide {"id":"${CHAT_REQUEST.id}","approve":false,"note":"Not during the release"}`,
  );
});

test.describe('with chat turned off', () => {
  test.use({ agentOptions: { chat: false } });
  test('has no Chat page', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Chat' })).toHaveCount(0);
  });
});

test('works in Arabic, right to left', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Switch to Arabic' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1, name: 'نظرة عامة' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'الاستهلاك' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'الاستهلاك' })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'المحادثة' }).click();
  await page.getByLabel('الرسالة').fill('لماذا يعيد web التشغيل؟');
  await page.getByRole('button', { name: 'إرسال' }).click();
  await expect(
    page.getByRole('log').getByRole('group', { name: 'يحتاج إلى موافقة' }),
  ).toBeVisible();
});

test('has no accessibility violations', async ({ page }) => {
  await signIn(page);
  for (const name of ['Overview', 'Connectors', 'Activity', 'Usage', 'Approvals', 'Chat']) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (name === 'Chat') {
      await page.getByLabel('Message').fill('Why does web keep restarting?');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('log').getByRole('group')).toBeVisible();
    }
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
