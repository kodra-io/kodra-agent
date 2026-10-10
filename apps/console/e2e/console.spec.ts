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
  // The dashboard: approvals waiting, investigations, changes, and spend against the budget.
  await expect(page.getByText('PodCrashLooping, ')).toBeVisible();
  await expect(page.getByText('3 approved, 1 denied')).toBeVisible();
  await expect(page.getByText('$12.40')).toBeVisible();
  await expect(page.getByText('of $40.00')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Budget used' })).toHaveAttribute(
    'aria-valuenow',
    '31',
  );
  await expect(page.getByText('Open MR: README note')).toBeVisible();
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
  const nav = page.getByRole('navigation');
  await expect(nav).toContainText('View and chat');
  // The approvals badge, in the sidebar and in the tab title.
  await expect(nav.getByRole('link', { name: 'Approvals' })).toContainText('3');
  await expect(page).toHaveTitle('(3) Console | Kodra AI Agent');
  await nav.getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByRole('tab', { name: 'Waiting (3)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const waiting = page.getByRole('group', { name: 'Needs approval' });
  await expect(waiting).toHaveCount(3);
  await expect(waiting.first()).toContainText('github/create_pull_request');
  await expect(waiting.first()).toContainText('Waiting for an approver.');
  await expect(page.locator('main').getByRole('button', { name: /approve|deny/i })).toHaveCount(0);
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('No decision recorded')).toBeVisible();
  await expect(page.getByText('approved by U-OMAR')).toBeVisible();
});

test('a console approver approves a waiting request after confirming', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await expect(page.getByRole('navigation')).toContainText('console:omar');
  await expect(page.getByRole('navigation')).toContainText('Approver');
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  const waiting = page.getByRole('group', { name: 'Needs approval' });
  const pr = waiting.filter({ hasText: 'Open the fix for review.' });
  await pr.getByRole('button', { name: 'Approve' }).click();
  // Nothing is sent until the second, explicit step.
  expect(api.some((a) => a.startsWith('POST approvals/decide'))).toBe(false);
  await expect(pr).toContainText('Run github/create_pull_request now? This changes your system.');
  await pr.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(waiting).toHaveCount(2);
  expect(api).toContain('BODY approvals/decide {"id":"req-2","approve":true}');

  // A request that expired meanwhile says so, and nothing runs.
  const old = waiting.filter({ hasText: 'Old request.' });
  await old.getByRole('button', { name: 'Approve' }).click();
  await old.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(old.getByRole('alert')).toHaveText('This request expired. Nothing was run.');
  await expect(old.getByRole('button')).toHaveCount(0);
});

test('anyone can pause changes; only an approver resumes', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Pause all changes' }).click();
  const banner = page.getByRole('status').filter({ hasText: 'Changes are paused.' });
  await expect(banner).toContainText('Paused by console');
  await expect(banner).toContainText('An approver can resume.');
  await expect(page.getByRole('button', { name: 'Resume changes' })).toHaveCount(0);
  await expect(page.getByRole('navigation')).toContainText('Changes paused');
  expect(api.some((a) => a.startsWith('BODY agent/pause'))).toBe(true);

  // An approver signs in and resumes.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('status').getByRole('button', { name: 'Resume changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Changes are paused.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause all changes' })).toBeVisible();
  expect(api.some((a) => a.startsWith('BODY agent/resume'))).toBe(true);
});

test('shows a proposed change by its title, with the diff to review', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  const card = page
    .getByRole('group', { name: 'Needs approval' })
    .filter({ hasText: 'Raise web replicas to 3' });
  await expect(card).toContainText('Raise web replicas to 3');
  await expect(card).toContainText('Steps');
  const preview = card.getByLabel('Preview of the change');
  await expect(preview).toContainText('--- a/deploy/values.yaml (main)');
  await expect(preview.getByText('+replicas: 3', { exact: true })).toBeVisible();
  await expect(preview.getByText('-replicas: 2', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toContainText('Run Raise web replicas to 3 now? This changes your system.');
  await card.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(card).toHaveCount(0);
  expect(api).toContain('BODY approvals/decide {"id":"req-change","approve":true}');
});

test('chats with the agent and shows each step live', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible();
  await page.getByLabel('Message').fill('Why does web keep restarting?');
  await page.getByRole('button', { name: 'Send' }).click();

  const log = page.getByRole('log');
  await expect(log).toContainText('Why does web keep restarting?');
  // The answer appears as it is written, with markdown.
  await expect(log.getByText('out of memory', { exact: true })).toHaveCount(1);
  await expect(log.locator('strong')).toHaveText('out of memory');
  // Tool calls fold into one line that opens to the details.
  const tools = log.getByRole('button', { name: /Used 1 tool/ });
  await expect(tools).toContainText('pods_log');
  await tools.click();
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
  // While it works, Stop replaces Send.
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

  await expect(page.getByRole('complementary', { name: 'Conversations' })).toContainText(
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

test('stops an answer: keeps what it said, and the waiting change closes', async ({
  page,
  api,
}) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Message').fill('Why does web keep restarting?');
  await page.getByRole('button', { name: 'Send' }).click();
  const log = page.getByRole('log');
  await expect(log.getByRole('group', { name: 'Needs approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(log).toContainText('(Stopped. Nothing more was run.)');
  await expect(log.getByRole('group', { name: 'Needs approval' })).toHaveCount(0);
  await expect(log).toContainText('This request expired. Nothing was run.');
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  expect(api.some((a) => a.startsWith('BODY chat/stop'))).toBe(true);
});

test('starts with suggestions from the connectors, and Enter sends', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { name: 'What should we look at?' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('I can read GitLab, Docker.');
  await page
    .getByRole('button', { name: /Which merge requests or pull requests are open/ })
    .click();
  await expect(page.getByRole('log')).toContainText(
    'Which merge requests or pull requests are open?',
  );
  expect(api).toContain('BODY chat {"text":"Which merge requests or pull requests are open?"}');

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Message').fill('First line');
  await page.getByLabel('Message').press('Shift+Enter');
  await page.getByLabel('Message').pressSequentially('second line');
  await page.getByLabel('Message').press('Enter');
  expect(api).toContain('BODY chat {"text":"First line\\nsecond line"}');
});

test('keeps the open conversation when you leave the Chat page and come back', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await page.getByLabel('Message').fill('Why does web keep restarting?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log')).toContainText('pods_log');
  await page.getByRole('navigation').getByRole('link', { name: 'Usage' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByRole('log')).toContainText('Why does web keep restarting?');
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('heading', { name: 'What should we look at?' })).toBeVisible();
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

test('has no accessibility violations, in both themes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const name of ['Overview', 'Approvals']) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `dark ${name}: ${v.id}`)).toEqual([]);
  }
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
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
  // On a phone the sections fold behind the Menu button.
  const menu = page.getByRole('button', { name: 'Menu' });
  const phone = await menu.isVisible();
  if (phone) await menu.click();
  await page.getByRole('navigation').getByRole('link', { name: 'Activity' }).click();
  if (phone) await expect(page.getByRole('navigation')).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
