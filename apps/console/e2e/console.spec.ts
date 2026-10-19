import { AxeBuilder } from '@axe-core/playwright';
import {
  ADMIN_PASSWORD,
  APPROVER_TOKEN,
  CHAT_REQUEST,
  expect,
  HOSTILE,
  NEW_TOKEN,
  settled,
  signIn,
  test,
  TOKEN,
} from './fixtures.ts';

test('asks for the token, refuses a wrong one, and signs in', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign in with a token instead' }).click();
  await page.getByLabel('Console token').fill('not-it');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('That token is not right.');

  await page.getByLabel('Console token').fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByText('anthropic/claude-sonnet-5-5')).toBeVisible();
  await expect(page.getByText('2 h 3 min')).toBeVisible();
  const systems = page
    .getByRole('region', { name: /^Systems/ })
    .getByRole('listitem')
    .filter({ hasText: 'Kubernetes' });
  await expect(systems).toContainText('Offline');
  // Key numbers: investigations, changes, and spend against the budget.
  const kpis = page.getByRole('list', { name: 'Key numbers' });
  await expect(kpis.getByText('PodCrashLooping, ')).toBeVisible();
  await expect(kpis).toContainText('3 approved, 1 denied');
  await expect(kpis).toContainText('$12.40');
  await expect(kpis).toContainText('of $40.00');
  await expect(page.getByRole('progressbar', { name: 'Budget used' })).toHaveAttribute(
    'aria-valuenow',
    '31',
  );
  await expect(page.getByText('Open MR: README note')).toBeVisible();
  expect(api).toContain('POST login');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('admin signs in with admin/admin and must set a new password first', async ({ page, api }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('That username or password is not right.');

  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await page.getByLabel('Current password').fill('admin');
  await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('New password again').fill('something else');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two new passwords do not match.');

  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('New password again').fill('short');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Use at least 12 characters, different from the current password.',
  );

  await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('New password again').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  expect(api).toContain('POST password');
  expect(api.join('\n')).not.toContain(ADMIN_PASSWORD);
});

test.describe('the operations center', () => {
  test.use({ timezoneId: 'UTC' });

  test('shows the clock, the posture, key numbers, the queue worst first, and each system', async ({
    page,
    api,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-19T08:30:00Z'));
    await signIn(page, APPROVER_TOKEN);
    const ops = page.getByRole('region', { name: 'Good morning, Omar' });
    await expect(ops).toContainText('Operations center');
    await expect(ops).toContainText('Monday, October 19, 2026');
    await expect(ops.locator('time')).toHaveText('08:30:00');
    await expect(ops).toContainText('Attention required');
    expect(api).toContain('GET dashboard');

    const kpis = ops.getByRole('list', { name: 'Key numbers' });
    await expect(kpis).toContainText('Pods up5/71 failing');
    await expect(kpis).toContainText('Deployments ready2/3');
    await expect(kpis).toContainText('Failed runs2');

    const queue = ops.getByRole('region', { name: /^Attention queue/ }).getByRole('listitem');
    await expect(queue).toHaveText([
      'Critical1 pod is failing in dev',
      'CriticalKubernetes is not available',
      /^Action\d+ approvals? (is|are) waiting for a decision$/,
      'Warning1 deployment is not fully ready',
      'Warning2 recent pipeline runs or jobs failed',
      'Info1 alert was investigated today',
    ]);

    const systems = ops.getByRole('region', { name: /^Systems/ }).getByRole('listitem');
    await expect(systems).toHaveText(['GitLabConnectedOK', 'KubernetesNot runningOffline']);

    await queue.filter({ hasText: 'pod is failing' }).getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('asks the agent for a full briefing in a new conversation', async ({ page, api }) => {
    await page.clock.setFixedTime(new Date('2026-10-19T19:00:00Z'));
    await signIn(page);
    // The shared token has no name to greet.
    const ops = page.getByRole('region', { name: 'Good evening' });
    await ops.getByRole('link', { name: 'Request a full briefing' }).click();
    await expect(page.getByLabel('Message')).toHaveValue(/^Give me a briefing on what is going on/);
    // Nothing is sent until the person sends it.
    expect(api.some((line) => line.startsWith('BODY chat '))).toBe(false);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('log')).toContainText('Give me a briefing');

    // Back on Chat later, it opens as usual, not on a new briefing.
    await page.getByRole('navigation').getByRole('link', { name: 'Usage' }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Chat' }).click();
    await expect(page.getByLabel('Message')).toHaveValue('');
  });

  test('works in Arabic, right to left', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-19T14:00:00Z'));
    await signIn(page, APPROVER_TOKEN);
    await page.getByRole('button', { name: 'Switch to Arabic' }).click();
    const ops = page.getByRole('region', { name: 'مساء الخير يا Omar' });
    await expect(ops).toContainText('مركز العمليات');
    await expect(ops).toContainText('يتطلب تدخلًا');
    await expect(ops).toContainText('Pods متعثرة في dev: 1');
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  });

  test('boots with motion, and holds still with reduced motion', async ({ page }) => {
    await signIn(page, APPROVER_TOKEN);
    const ops = page.getByRole('region', { name: /Omar$/ });
    const running = () =>
      ops.evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.playState));
    await expect.poll(running).toContain('running');
    await expect(ops.getByRole('list', { name: 'Key numbers' })).toContainText('$12.40');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(ops.getByRole('list', { name: 'Key numbers' })).toContainText('Pods up5/7');
    expect(await running()).toEqual([]);
  });
});

test('shows why a connector is not available, and the tools it gives', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button', { name: 'Configure Kubernetes' }).click();
  await expect(page.getByRole('note')).toContainText('missing Kubernetes kubeconfig');
  await expect(page.getByRole('note')).toContainText('copy it to secrets/kubeconfig');
  // A file secret is changed on the host, not here.
  await expect(
    page.getByText('This one is a file. Put it at /secrets/kubeconfig on the host'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connectors' }).click();
  await page.getByRole('button', { name: 'Configure GitLab' }).click();
  await page.getByText(/Tools the agent gets/).click();
  await expect(page.getByText('list_merge_requests')).toBeVisible();
  // A limit every tool shares is shown once.
  await expect(page.getByText('project_id must be one of: jordan-kodra/terraform')).toHaveCount(1);
  await expect(page.getByText('Every tool:')).toBeVisible();
});

test('settings are read-only for the shared token', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('only a console approver can change settings')).toBeVisible();
  await page.getByRole('button', { name: 'Configure GitLab' }).click();
  await expect(page.getByRole('radio', { name: /Read and write/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Replace' })).toHaveCount(0);
  // Anyone can test a connection: it only reads.
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('list', { name: 'Connection checks' })).toContainText(
    'can read 1 project',
  );
});

test('an approver changes a connector: review the diff and the access it adds, then restart', async ({
  page,
  api,
}) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Configure GitLab' }).click();
  await page.getByRole('radio', { name: /Read and write, with approval/ }).check();
  await page.getByLabel('Projects the agent may use.').fill('jordan-kodra/payments');
  await page.getByLabel('Projects the agent may use.').press('Enter');

  const review = page.getByRole('complementary', { name: 'Review changes' });
  await expect(review).toContainText('More access');
  await expect(review).toContainText('GitLab can propose changes, each after an approval.');
  await expect(review).toContainText('GitLab can reach jordan-kodra/payments.');
  const diff = review.getByLabel('Changes to kodra-agent.yaml');
  await expect(diff.getByText('+      access: read-write-approved', { exact: true })).toBeVisible();

  await review.getByRole('button', { name: 'Save and restart' }).click();
  // Nothing is saved until the second step.
  expect(api.some((a) => a.startsWith('BODY settings/apply'))).toBe(false);
  await review.getByRole('button', { name: 'Yes, save and restart' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restarting the agent' })).toBeVisible();
  // Back: the review is gone, and Undo is offered.
  await expect(page.getByRole('button', { name: 'Undo last change' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(review).toHaveCount(0);
  expect(
    api.some(
      (a) =>
        a.startsWith('BODY settings/apply') &&
        a.includes(
          '"gitlab":{"access":"read-write-approved","config":{"projects":["jordan-kodra/terraform","jordan-kodra/payments"]}}',
        ),
    ),
  ).toBe(true);

  await page.getByRole('button', { name: 'Undo last change' }).click();
  await page.getByRole('button', { name: 'Yes, undo' }).click();
  await expect(page.getByRole('button', { name: 'Undo last change' })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('replaces a token only after it passes the check', async ({ page }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Configure GitLab' }).click();
  await page.getByRole('button', { name: 'Replace' }).click();
  const field = page.getByLabel('New value for GitLab token (GITLAB_TOKEN)');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('glpat-a-wrong-token');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Not saved: GitLab token: HTTP 401 for jordan-kodra/terraform',
  );
  await field.fill('glpat-a-good-new-token');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restarting the agent' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({
    timeout: 15_000,
  });
});

test('sets a monthly budget', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Model and limits' }).click();
  await page.getByLabel('Budget per month, in US dollars').fill('40');
  await expect(page.getByRole('complementary', { name: 'Review changes' })).toContainText(
    'monthlyBudgetUsd: 40',
  );
  expect(
    api.some((a) => a.startsWith('BODY settings/preview') && a.includes('"monthlyBudgetUsd":40')),
  ).toBe(true);
});

test('picks a model from the list, with prices and this month on each', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Model and limits' }).click();
  const models = page.getByRole('radiogroup', { name: 'Model' });
  await expect(models.getByRole('radio', { name: /claude-sonnet-5-5/ })).toBeChecked();
  await expect(models).toContainText('This month: $12.40');
  await expect(models).toContainText('This month on it: $24.80');
  await expect(models).toContainText('$4.00 in, $20.00 out');
  await expect(models).toContainText('Not listed for your key');

  await models.getByRole('radio', { name: /claude-opus-5-5/ }).check();
  await page.getByRole('button', { name: 'Test claude-opus-5-5' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'It answered' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Review changes' })).toContainText(
    'name: claude-opus-5-5',
  );

  await models.getByRole('radio', { name: 'Another model' }).check();
  await page.getByLabel('Model name').fill('claude-typo');
  await page.getByRole('button', { name: 'Test claude-typo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'did not answer' })).toContainText(
    'not_found_error',
  );
  expect(api.some((a) => a.startsWith('BODY settings/model-test'))).toBe(true);

  // A model that answers, but with a window too small for the agent: said plainly.
  await page.getByLabel('Model name').fill('local-small');
  await page.getByRole('button', { name: 'Test local-small' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'OLLAMA_CONTEXT_LENGTH' })).toContainText(
    'local-small runs with 4,096 tokens of context, and this agent needs about 52,000',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test('switches the model provider: key checked, models listed, then switched', async ({
  page,
  api,
}) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Model and limits' }).click();
  await page.getByRole('button', { name: 'Change provider' }).click();
  const providers = page.getByRole('radiogroup', { name: 'Model provider' });
  await providers.getByRole('radio', { name: /OpenAI/ }).check();
  const check = page.getByRole('button', { name: 'Check OpenAI' });
  // No key in .env yet: it must be typed first.
  await expect(check).toBeDisabled();
  const key = page.getByLabel(/OpenAI API key/);
  await expect(key).toHaveAttribute('type', 'password');

  await key.fill('sk-wrong');
  await check.click();
  await expect(page.getByRole('alert')).toContainText('the provider check failed');

  await key.fill('sk-e2e-openai-key');
  await check.click();
  await expect(page.getByRole('list', { name: 'Checks' })).toContainText('API key accepted');
  const models = page.getByRole('radiogroup', { name: 'Model at the new provider' });
  await expect(models.getByRole('radio', { name: 'gpt-5.1', exact: true })).toBeChecked();
  await expect(models).toContainText('This month on it: $9.10');
  await expect(page.getByRole('note')).toContainText(
    'From now on, questions, logs, and tool output go to OpenAI.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  // A model whose window is too small: the switch stops once to say so.
  await models.getByRole('radio', { name: 'gpt-5.1-mini', exact: true }).check();
  await page.getByRole('button', { name: 'Switch to OpenAI, gpt-5.1-mini' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'OLLAMA_CONTEXT_LENGTH' })).toContainText(
    'gpt-5.1-mini runs with 4,096 tokens of context',
  );
  await expect(page.getByRole('button', { name: 'Switch anyway' })).toBeVisible();
  await models.getByRole('radio', { name: 'gpt-5.1', exact: true }).check();
  await page.getByRole('button', { name: 'Switch to OpenAI, gpt-5.1' }).click();
  await expect
    .poll(() => api.some((a) => a.startsWith('BODY settings/provider-switch')))
    .toBe(true);
  const sent = api.filter((a) => a.startsWith('BODY settings/provider-switch')).at(-1) ?? '';
  expect(sent).toContain('"provider":"openai"');
  expect(sent).toContain('"name":"gpt-5.1"');
  // The key is gone from the page once it is sent.
  await expect(page.getByLabel(/OpenAI API key/)).toHaveCount(0);
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

test('adds an approver: the token is shown once, through the restart', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'People and tokens' }).click();
  await expect(page.getByRole('heading', { name: 'Who can sign in' })).toBeVisible();
  await expect(page.getByText('Shared sign-in (team)').first()).toBeVisible();
  await expect(page.getByText('Other approvers (Slack):')).toContainText('@omar');
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);

  await page.getByLabel('Add a console approver').fill('On Call');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('lowercase letters');

  await page.getByLabel('Add a console approver').fill('on-call');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const panel = page.getByRole('region', { name: 'New token for console:on-call' });
  await expect(panel.getByLabel('Token')).toHaveValue(NEW_TOKEN);
  await expect(panel.getByText('The agent is back. The new token works now.')).toBeVisible();
  expect(api).toContain('BODY people/add {"name":"on-call"}');
  await expect(page.getByText('KODRA_CONSOLE_TOKEN_ON_CALL')).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove console:on-call' }).click();
  await expect(page.getByText('They can no longer sign in or approve here.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('KODRA_CONSOLE_TOKEN_ON_CALL')).toHaveCount(0);

  // Signing a browser out needs no restart.
  const sessions = page.getByRole('table');
  await expect(sessions.getByRole('row')).toHaveCount(3);
  await sessions
    .getByRole('row')
    .filter({ hasText: 'Shared sign-in' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(sessions.getByRole('row')).toHaveCount(2);
});

test('rotating your own token signs you in again with the new one', async ({ page, api }) => {
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'People and tokens' }).click();
  await page.getByRole('button', { name: 'Rotate the token for console:omar' }).click();
  await expect(page.getByText('This is your token')).toBeVisible();
  await page.getByRole('button', { name: 'Rotate token', exact: true }).click();
  const panel = page.getByRole('region', { name: 'New token for console:omar' });
  await expect(panel.getByLabel('Token')).toHaveValue(NEW_TOKEN);
  await expect(panel.getByText('Your token changed, so sign in with the new one.')).toBeVisible();
  expect(api).toContain('BODY people/rotate {"who":"console:omar"}');
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('the dashboard shows what the connectors see, as plain text', async ({ page, api }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  expect(api).toContain('GET dashboard');

  const tiles = page.getByRole('list', { name: 'Summary' });
  await expect(tiles).toContainText('Pods running5');
  await expect(tiles).toContainText('Pods failing1');
  await expect(tiles).toContainText('Deployments ready2 of 3');
  // Pipelines and Jenkins jobs count together.
  await expect(tiles).toContainText('Failed runs2');

  const pods = page.getByRole('article', { name: 'Pods' });
  await expect(pods.getByText('CrashLoopBackOff')).toBeVisible();
  await expect(pods.getByText('14 restarts')).toBeVisible();
  await expect(pods).toContainText('prod: could not read (pods is forbidden)');
  await expect(page.getByRole('progressbar', { name: 'Deployments ready' })).toHaveAttribute(
    'aria-valuenow',
    '2',
  );

  // Tool output is text: the hostile message is shown, never rendered as HTML.
  const warnings = page.getByRole('article', { name: 'Recent warnings' });
  await expect(warnings).toContainText(HOSTILE);
  await expect(warnings.locator('img')).toHaveCount(0);

  const pipelines = page.getByRole('article', { name: 'Pipelines' });
  await expect(pipelines).toContainText('75% of finished runs passed');
  const open = pipelines.getByRole('link', { name: 'Open run 501' });
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(open).toHaveAttribute('href', /^https:\/\/gitlab\.com\//);
  // A run without a web link has no link.
  await expect(pipelines.getByRole('link', { name: 'Open run 500' })).toHaveCount(0);

  const jobs = page.getByRole('article', { name: 'Jobs' });
  await expect(jobs).toContainText('1 failed');
  await expect(jobs.getByRole('link', { name: 'Open job deploy-web' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(jobs.getByRole('link', { name: 'Open job team-a/api' })).toHaveCount(0);

  await expect(page.getByRole('article', { name: 'Workflow runs' })).toContainText(
    'Nothing is listed for this connector yet.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test('only approvers see People and tokens', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Connectors' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'People and tokens' })).toHaveCount(0);
});

test('has no accessibility violations, in both themes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const name of ['Overview', 'Dashboard', 'Approvals']) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await settled(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `dark ${name}: ${v.id}`)).toEqual([]);
  }
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  for (const name of [
    'Overview',
    'Dashboard',
    'Settings',
    'Activity',
    'Usage',
    'Approvals',
    'Chat',
  ]) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (name === 'Chat') {
      await page.getByLabel('Message').fill('Why does web keep restarting?');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('log').getByRole('group')).toBeVisible();
    }
    await settled(page);
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

test('a production change needs two approvers, and the requester cannot approve it', async ({
  page,
}) => {
  const production = {
    id: 'req-prod',
    connector: 'kubernetes',
    tool: 'resources_scale',
    risk: 'write',
    args: '{"namespace":"shop","replicas":4}',
    reason: 'More traffic.',
    requestedBy: 'slack:U1',
    expiresAt: '2026-10-09T09:30:00.000Z',
    environment: 'production',
    needed: 2,
    approvedBy: [] as string[],
    cannotApprove: null as string | null,
  };
  let waitingList = [
    production,
    {
      ...production,
      id: 'req-mine',
      reason: 'My own change.',
      requestedBy: 'console:omar',
      cannotApprove: 'self',
    },
  ];
  await page.route('**/api/approvals/pending', (route) => route.fulfill({ json: waitingList }));
  await page.route('**/api/approvals/decide', (route) => {
    waitingList = waitingList.map((p) =>
      p.id === 'req-prod'
        ? { ...p, approvedBy: ['console:omar'], cannotApprove: 'already-approved' }
        : p,
    );
    return route.fulfill({ json: { result: 'counted' } });
  });
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  const waiting = page.getByRole('group', { name: 'Needs approval' });

  const card = waiting.filter({ hasText: 'More traffic.' });
  await expect(card).toContainText('Environment: production');
  await expect(card).toContainText('0 of 2 approved');
  await card.getByRole('button', { name: 'Approve' }).click();
  await card.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(card.getByRole('status')).toHaveText(
    'Your approval is counted. It needs another approver.',
  );

  const mine = waiting.filter({ hasText: 'My own change.' });
  await expect(mine).toContainText('You asked for this change, so someone else must approve it.');
  await expect(mine.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('approving during a freeze needs a reason, and a change reference where required', async ({
  page,
}) => {
  const frozen = {
    id: 'req-frozen',
    connector: 'kubernetes',
    tool: 'resources_scale',
    risk: 'write',
    args: '{"namespace":"shop","replicas":4}',
    reason: 'Hotfix during the weekend.',
    requestedBy: 'slack:U1',
    expiresAt: '2026-10-09T09:30:00.000Z',
    environment: 'production',
    needed: 1,
    approvedBy: [] as string[],
    cannotApprove: null,
    needs: { changeRef: true, reason: true },
    changeRefPattern: '^CHG[0-9]{7}$',
    changeRef: null,
    override: null,
    freeze: { name: 'weekend', until: 'Sat 23:59', timezone: 'Asia/Amman' },
  };
  const sent: Record<string, unknown>[] = [];
  let waitingList: (typeof frozen)[] = [frozen];
  await page.route('**/api/approvals/pending', (route) => route.fulfill({ json: waitingList }));
  await page.route('**/api/approvals/decide', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (body['changeRef'] !== 'CHG1234567') {
      return route.fulfill({
        status: 403,
        json: {
          error: 'bad ref',
          result: 'refused',
          refusal: 'change-ref-format',
        },
      });
    }
    waitingList = [];
    return route.fulfill({ json: { result: 'approved' } });
  });
  await signIn(page, APPROVER_TOKEN);
  await page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).click();
  const card = page.getByRole('group', { name: 'Needs approval' });
  await expect(card).toContainText(
    'production is frozen (weekend, until Sat 23:59 Asia/Amman). Approving overrides the freeze, and every approver is told.',
  );
  await card.getByRole('button', { name: 'Approve' }).click();
  const run = card.getByRole('button', { name: 'Yes, run it' });
  // Both are required before it can be sent.
  await expect(run).toBeDisabled();
  await card.getByLabel('Reason for overriding the freeze').fill('Customers cannot pay.');
  await card.getByLabel('Change reference').fill('chg-1');
  await expect(card.getByText('Format: ^CHG[0-9]{7}$')).toBeVisible();
  await run.click();
  await expect(card.getByRole('alert')).toHaveText(
    'The change reference does not have the required format.',
  );
  // Fixed in place, without starting over.
  await card.getByLabel('Change reference').fill('CHG1234567');
  await card.getByRole('button', { name: 'Yes, run it' }).click();
  await expect(card).toHaveCount(0);
  expect(sent.at(-1)).toEqual({
    id: 'req-frozen',
    approve: true,
    changeRef: 'CHG1234567',
    reason: 'Customers cannot pay.',
  });
});

test.describe('strict', () => {
  test.use({ agentOptions: { chat: true, policyChanges: 'second-approver' } });

  test('a policy change from the console waits for a second approver', async ({ page }) => {
    await signIn(page, APPROVER_TOKEN);
    await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Configure GitLab' }).click();
    await page.getByRole('radio', { name: /Read and write, with approval/ }).check();
    const review = page.getByRole('complementary', { name: 'Review changes' });
    await expect(review).toContainText(
      'This changes who may change what. It waits for a second approver before it applies.',
    );
    await review.getByRole('button', { name: 'Save and restart' }).click();
    await review.getByRole('button', { name: 'Yes, save and restart' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved for review' })).toBeVisible();
    // Nothing restarted; the change is listed until someone else approves it.
    await expect(page.getByRole('region', { name: 'Waiting for a second approver' })).toContainText(
      'changed gitlab.access',
    );
  });
});
