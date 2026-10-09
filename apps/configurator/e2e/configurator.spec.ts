import { AxeBuilder } from '@axe-core/playwright';
import { parseAgentConfig } from '@kodra-agent/connectors';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { connectorCard, enableConnector, expect, fillBasics, goToStep, test } from './fixtures.ts';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    localStorage.setItem('kodra-agent.lang', 'en');
  });
  await page.goto('./');
});

test('builds a config through all five steps and downloads a valid bundle', async ({ page }) => {
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

test('coming-soon connectors are visible but cannot be enabled', async ({ page }) => {
  await fillBasics(page);
  const teams = connectorCard(page, 'teams');
  await expect(teams.getByText('Coming soon')).toBeVisible();
  await expect(teams.getByRole('switch')).toBeDisabled();
});

test('switching to Arabic sets right-to-left and translates the page', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to Arabic' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('أنشئ وكيلك');
  await expect(page.getByTestId('privacy-line')).toHaveText(
    'هذه الصفحة لا تطلب مفاتيحك أبدا. اختياراتك تبقى في متصفحك.',
  );
  await page.getByRole('button', { name: 'التالي' }).click();
  await expect(page.getByRole('heading', { name: 'اختر مزوّد النموذج' })).toBeVisible();

  // The choice survives a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('a shared link restores the same setup', async ({ page, context }) => {
  await fillBasics(page);
  await enableConnector(page, 'gitlab', 'GitLab');
  await connectorCard(page, 'gitlab').getByLabel('Projects the agent may use.').fill('acme/api');
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

for (const lang of ['en', 'ar'] as const) {
  test(`has no WCAG 2.1 AA violations on any step (${lang}) @mobile`, async ({ page }) => {
    await page.evaluate((l) => {
      localStorage.setItem('kodra-agent.lang', l);
    }, lang);
    await page.reload();
    const steps =
      lang === 'en'
        ? ['Start', 'Model', 'Connectors', 'Review', 'Download']
        : ['البداية', 'النموذج', 'الموصلات', 'المراجعة', 'التنزيل'];
    for (const step of steps) {
      await goToStep(page, new RegExp(step));
      if (step === 'Connectors' || step === 'الموصلات') {
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
}

test('works at phone width without horizontal scrolling @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await fillBasics(page);
  await enableConnector(page, 'github', 'GitHub');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
