import { AxeBuilder } from '@axe-core/playwright';
import { parseAgentConfig } from '@kodra-agent/connectors';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { connectorCard, enableConnector, expect, fillBasics, goToStep, test } from './fixtures.ts';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('builds a starter config step by step and downloads a valid bundle', async ({ page }) => {
  await fillBasics(page);

  await enableConnector(page, 'github', 'GitHub');
  const github = connectorCard(page, 'github');
  await github.getByLabel('Read and write, with approval').check();
  await github.getByLabel('Repositories the agent may use.').fill('acme/payments-api');
  await expect(github.getByText('GITHUB_TOKEN')).toBeVisible();

  await enableConnector(page, 'kubernetes', 'Kubernetes');
  await connectorCard(page, 'kubernetes')
    .getByLabel(/Namespaces the agent may access/)
    .fill('payments');

  await enableConnector(page, 'prometheus', 'Prometheus');
  await connectorCard(page, 'prometheus')
    .getByLabel('Prometheus address.')
    .fill('http://prometheus:9090');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Review permissions' })).toBeFocused();
  await page.getByLabel('Approvers').fill('@omar');
  await expect(page.getByText('Everything checks out. You can download your agent.')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download kodra-agent-payments-team-agent.zip' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('kodra-agent-payments-team-agent.zip');

  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const root = 'kodra-agent-payments-team-agent/';
  expect(
    Object.keys(zip.files)
      .filter((f) => !f.endsWith('/'))
      .sort(),
  ).toEqual(
    ['kodra-agent.yaml', '.env.example', '.gitignore', 'docker-compose.yml', 'README.md']
      .map((f) => root + f)
      .sort(),
  );
  const yaml = await zip.file(`${root}kodra-agent.yaml`)?.async('string');
  const result = parseAgentConfig(yaml ?? '');
  expect(result.ok ? [] : result.issues).toEqual([]);
  if (result.ok) {
    expect(result.config.spec.connectors['github']).toMatchObject({
      enabled: true,
      access: 'read-write-approved',
      config: { repos: ['acme/payments-api'] },
      secrets: { token: '${env:GITHUB_TOKEN}' },
    });
  }
  const env = await zip.file(`${root}.env.example`)?.async('string');
  expect(env?.split('\n').filter((l) => /^[A-Z_]+=/.test(l))).toEqual([
    'ANTHROPIC_API_KEY=',
    'GITHUB_TOKEN=',
  ]);
});

test('adds databases, one through a tunnel, and the bundle names their secrets', async ({
  page,
}) => {
  await fillBasics(page);
  await enableConnector(page, 'databases', 'Databases');
  const card = connectorCard(page, 'databases');
  await expect(card.getByText('None yet. Add them here, or later in the console.')).toBeVisible();
  await expect(card.getByText('Each database you add names its own secrets here.')).toBeVisible();

  await card.getByRole('button', { name: 'Add database' }).click();
  await card.getByRole('textbox', { name: 'Name', exact: true }).fill('Orders');
  // Shown on the entry, and under what the setup will ask for.
  await expect(card.getByText('KODRA_DB_ORDERS_PASSWORD')).toHaveCount(2);
  await card.getByLabel(/^Host name or IP address/).fill('orders.internal');
  await card.getByLabel('Database user.').fill('kodra_monitor');

  await card.getByRole('button', { name: 'Add database' }).click();
  const second = card.locator('[data-entry="1"]');
  await second.getByRole('textbox', { name: 'Name', exact: true }).fill('billing');
  await second.getByLabel('Database engine.').selectOption('postgres');
  await second.getByLabel(/^Host name or IP address/).fill('10.0.3.12');
  await second.getByLabel('Database user.').fill('kodra_monitor');
  await second.getByText('More settings').click();
  await second.getByLabel(/^SSH tunnel: the bastion host/).fill('bastion.example.com');
  await second.getByLabel(/^SSH tunnel: the user on the bastion/).fill('kodra');
  await expect(second.getByText('KODRA_DB_BILLING_TUNNEL_KEY')).toBeVisible();
  // A tunnel needs the bastion's host key: the download stays blocked until it is set.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('problems').getByText('This field is required.')).toBeVisible();
  await goToStep(page, /Connectors/);
  await second.getByLabel(/host key/i).fill(`SHA256:${'A'.repeat(43)}`);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  await goToStep(page, /Review/);
  await expect(page.getByText('Everything checks out. You can download your agent.')).toBeVisible();
  await expect(page.getByText('Databases (billing):')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download kodra-agent-payments-team-agent.zip' }).click();
  const zip = await JSZip.loadAsync(await readFile(await (await downloadPromise).path()));
  const root = 'kodra-agent-payments-team-agent/';
  const result = parseAgentConfig(
    (await zip.file(`${root}kodra-agent.yaml`)?.async('string')) ?? '',
  );
  expect(result.ok ? [] : result.issues).toEqual([]);
  if (result.ok) {
    expect(result.config.spec.connectors['databases']?.config?.['databases']).toMatchObject([
      { name: 'orders', password: '${env:KODRA_DB_ORDERS_PASSWORD}' },
      {
        name: 'billing',
        engine: 'postgres',
        tunnelHost: 'bastion.example.com',
        tunnelKey: '${env:KODRA_DB_BILLING_TUNNEL_KEY}',
      },
    ]);
  }
  const env = await zip.file(`${root}.env.example`)?.async('string');
  expect(env?.split('\n').filter((l) => l.startsWith('KODRA_DB_'))).toEqual([
    'KODRA_DB_ORDERS_PASSWORD=',
    'KODRA_DB_BILLING_PASSWORD=',
    'KODRA_DB_BILLING_TUNNEL_KEY=',
  ]);

  // The databases are part of a shared link.
  await page.reload();
  await goToStep(page, /Connectors/);
  await expect(
    connectorCard(page, 'databases').getByRole('textbox', { name: 'Name', exact: true }),
  ).toHaveCount(2);
});

test('dependency warnings show inline and block the download', async ({ page }) => {
  await fillBasics(page);
  await enableConnector(page, 'github-actions', 'GitHub Actions');
  await expect(connectorCard(page, 'github-actions').getByRole('alert')).toHaveText(
    'GitHub Actions needs the GitHub connector, because it uses the same token.',
  );

  await goToStep(page, /Download/);
  await expect(page.getByRole('button', { name: /^Download kodra-agent-/ })).toBeDisabled();
  await expect(
    page.getByText('Fix the problems listed in Review before downloading.'),
  ).toBeVisible();

  await goToStep(page, /Connectors/);
  await enableConnector(page, 'github', 'GitHub');
  await expect(connectorCard(page, 'github-actions').getByRole('alert')).toHaveCount(0);
});

test('console approvers need the console, and chat can be turned off', async ({ page }) => {
  await fillBasics(page);
  await goToStep(page, /Review/);
  await page.getByLabel('Approvers').fill('@omar, console:omar');
  await expect(page.getByText('Everything checks out. You can download your agent.')).toBeVisible();

  const chat = page.getByRole('switch', { name: 'Chat in the console' });
  await expect(chat).toBeChecked();
  await chat.click();
  await expect(chat).not.toBeChecked();

  await page.getByRole('switch', { name: 'Turn on the web console' }).click();
  await expect(page.getByRole('switch', { name: 'Chat in the console' })).toHaveCount(0);
  await expect(
    page
      .getByTestId('problems')
      .getByText(
        'console:omar approves in the web console. Turn the console on, or remove console:omar.',
      ),
  ).toBeVisible();
});

test.describe('daily checks', () => {
  test.use({ timezoneId: 'Asia/Amman' });

  test('suggest weekdays at 09:00 in your time zone, say where the digest goes, and land in the YAML', async ({
    page,
  }) => {
    await fillBasics(page);
    await goToStep(page, /Review/);
    await page.getByLabel('Approvers').fill('@omar');
    const toggle = page.getByRole('switch', { name: 'Post a daily digest' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(page.getByRole('textbox', { name: 'Time', exact: true })).toHaveValue('09:00');
    await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Amman');
    await expect(page.getByLabel('Monday to Friday')).toBeChecked();
    // No Slack in this setup: the digest is on the console.
    await expect(page.getByTestId('checks-where')).toHaveText(
      "Slack is off, so the digest is shown on the console Overview and written to the agent's log.",
    );
    await page.getByRole('switch', { name: 'Turn on the web console' }).click();
    await expect(page.getByTestId('checks-where')).toContainText('only written to the agent');
    await page.getByRole('switch', { name: 'Turn on the web console' }).click();

    await page.getByRole('textbox', { name: 'Time', exact: true }).fill('9am');
    await expect(
      page.getByTestId('problems').getByText('Use a 24-hour time like 09:00.'),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Time', exact: true }).fill('07:45');
    await page.getByLabel('Every day').check();
    await expect(
      page.getByText('Everything checks out. You can download your agent.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Next' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download kodra-agent-payments-team-agent.zip' })
      .click();
    const zip = await JSZip.loadAsync(await readFile(await (await downloadPromise).path()));
    const yaml = await zip
      .file('kodra-agent-payments-team-agent/kodra-agent.yaml')
      ?.async('string');
    const result = parseAgentConfig(yaml ?? '');
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) {
      expect(result.config.spec.checks.schedules).toEqual([
        {
          name: 'daily',
          at: '07:45',
          days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
          timezone: 'Asia/Amman',
        },
      ]);
    }
    const readme = await zip.file('kodra-agent-payments-team-agent/README.md')?.async('string');
    expect(readme).toContain('At 07:45 (Asia/Amman), every day');
  });
});

test('coming-soon connectors are visible but cannot be enabled', async ({ page }) => {
  await fillBasics(page);
  const teams = connectorCard(page, 'teams');
  await expect(teams.getByText('Coming soon')).toBeVisible();
  await expect(teams.getByRole('switch')).toBeDisabled();
});

test('a shared link restores the same setup', async ({ page, context }) => {
  await fillBasics(page);
  await enableConnector(page, 'gitlab', 'GitLab');
  const beforeFill = page.url();
  await connectorCard(page, 'gitlab').getByLabel('Projects the agent may use.').fill('acme/api');
  // The link updates after each edit; wait for the one that includes the last edit.
  await expect.poll(() => page.url()).not.toBe(beforeFill);
  await expect(page).toHaveURL(/#v1\./);
  const link = page.url();
  expect(link).not.toContain('token');

  const other = await context.newPage();
  await other.goto(link);
  await other
    .getByRole('navigation')
    .getByRole('button', { name: /Connectors/ })
    .click();
  await expect(connectorCard(other, 'gitlab').getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(
    connectorCard(other, 'gitlab').getByLabel('Projects the agent may use.'),
  ).toHaveValue('acme/api');
  await other.getByRole('navigation').getByRole('button', { name: /Start/ }).click();
  await expect(other.getByLabel('Agent name')).toHaveValue('payments-team-agent');
});

test('the page has no secret inputs and sets a strict CSP', async ({ page, guard }) => {
  await fillBasics(page);
  for (const [id, name] of [
    ['github', 'GitHub'],
    ['slack', 'Slack'],
    ['grafana', 'Grafana'],
  ] as const) {
    await enableConnector(page, id, name);
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  const origin = new URL(page.url()).origin;
  expect(guard.requests.every((url) => url.startsWith(origin))).toBe(true);
});

test('a crafted link cannot enable a coming-soon connector or add fields', async ({ page }) => {
  const draft = {
    name: 'x',
    target: 'compose',
    model: { provider: 'anthropic', name: 'm', fields: { baseUrl: '', apiKey: 'sk-nope' } },
    connectors: { teams: { enabled: true, access: 'read-only', config: {}, optionalSecrets: [] } },
    policy: { approvers: '@a', expiresAfterMinutes: '15', destructiveActions: 'deny' },
  };
  const hash = `#v1.${Buffer.from(JSON.stringify(draft)).toString('base64url')}`;
  await page.goto(`./${hash}`);
  await goToStep(page, /Download/);
  await expect(page.getByRole('button', { name: /^Download kodra-agent-/ })).toBeDisabled();
  await expect(page.getByTestId('preview')).not.toContainText('sk-nope');
});

test('has no WCAG 2.1 AA violations on any step @mobile', async ({ page }) => {
  for (const step of ['Who is it for', 'Start', 'Model', 'Connectors', 'Review', 'Download']) {
    await goToStep(page, new RegExp(step));
    if (step === 'Connectors') {
      await connectorCard(page, 'github').getByRole('switch').click();
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
      step,
    ).toEqual([]);
  }
});

test('the team profile adds environments, and rules nobody can meet block the download', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: 'Who is this agent for?' })).toBeVisible();
  // Starter has no Environments step until one is added.
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /Environments/ }),
  ).toHaveCount(0);
  await page.getByRole('radio', { name: /^Team/ }).check();
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /Environments/ }),
  ).toBeVisible();
  await fillBasics(page);
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(
    page.getByRole('heading', { name: 'Group namespaces and repositories into environments' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Add a production environment' }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('production');
  await expect(page.getByRole('switch', { name: 'Production' })).toBeChecked();
  await page.getByLabel('Kubernetes namespaces').fill('payments');
  await expect(
    page.getByText('Needs one approval. The person who asked cannot approve it.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('textbox', { name: 'Approvers', exact: true }).fill('U0123ABCD');
  await expect(
    page
      .getByTestId('problems')
      .getByText(
        'Production changes need someone other than the requester. Add a second approver.',
      ),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Approvers', exact: true })
    .fill('U0123ABCD, console:lead');
  await expect(page.getByText('Everything checks out. You can download your agent.')).toBeVisible();
  await expect(page.getByTestId('approval-rules')).toContainText(
    'production (Production): Needs one approval. The person who asked cannot approve it.',
  );
  await expect(page.getByTestId('approval-rules')).toContainText(
    'Everything else: Needs one approval. The person who asked may approve it.',
  );
  await expect(page.getByTestId('preview')).toContainText('profile: team');
  await expect(page.getByTestId('preview')).toContainText('environments:');
});

test('the profile and environments steps work at phone width @mobile', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Who is this agent for?' })).toBeVisible();
  await page.getByRole('radio', { name: /^Strict/ }).check();
  await goToStep(page, /Environments/);
  await expect(
    page.getByRole('heading', { name: 'Group namespaces and repositories into environments' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add a production environment' }).click();
  await expect(
    page.getByText('Needs 2 different approvers. The person who asked cannot approve it.'),
  ).toBeVisible();
  for (const step of [/Who is it for/, /Environments/]) {
    await goToStep(page, step);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('works at phone width without horizontal scrolling @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await fillBasics(page);
  await enableConnector(page, 'github', 'GitHub');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
