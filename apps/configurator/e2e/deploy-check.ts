import { parseAgentConfig } from '@kodra-agent/connectors';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { HEADER_CONTENT_SECURITY_POLICY } from '../src/csp.ts';

/**
 * Checks a deployed configurator (L4), as docs/configurator-deploy.md lists it: the /agent
 * redirect, the security headers (the CSP exactly as the build has it), no request to another
 * origin, a bundle that downloads and validates, and the Build site's home page left alone.
 */

export interface DeployCheck {
  check: string;
  ok: boolean;
  detail: string;
}

/** CSP directives in any order and spacing, so only a real difference counts. */
function directives(policy: string): string[] {
  return policy
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
}

export async function checkDeploy(site: string): Promise<DeployCheck[]> {
  const origin = new URL(site).origin;
  const results: DeployCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail });

  // 1. /agent redirects to /agent/ (CloudFront viewer-request function).
  const bare = await fetch(`${origin}/agent`, { redirect: 'manual' });
  const location = bare.headers.get('location') ?? '';
  add(
    'redirect',
    [301, 302, 308].includes(bare.status) && new URL(location, origin).pathname === '/agent/',
    `/agent answers ${String(bare.status)}${location ? ` to ${location}` : ''}`,
  );

  // 2. The page and its headers (viewer-response function).
  const page = await fetch(`${origin}/agent/`);
  const html = await page.text();
  add(
    'page',
    page.status === 200 && html.includes('<div id="root">'),
    `/agent/ answers ${String(page.status)}`,
  );
  const csp = page.headers.get('content-security-policy') ?? '';
  const want = directives(HEADER_CONTENT_SECURITY_POLICY);
  const got = directives(csp);
  add(
    'csp header',
    JSON.stringify(got) === JSON.stringify(want),
    csp
      ? `missing: ${want.filter((d) => !got.includes(d)).join(', ') || 'none'}; extra: ${got.filter((d) => !want.includes(d)).join(', ') || 'none'}`
      : 'no Content-Security-Policy header',
  );
  const header = (name: string) => page.headers.get(name) ?? '';
  add(
    'frame options',
    header('x-frame-options').toUpperCase() === 'DENY',
    header('x-frame-options') || 'missing',
  );
  add(
    'nosniff',
    header('x-content-type-options') === 'nosniff',
    header('x-content-type-options') || 'missing',
  );
  add(
    'referrer policy',
    header('referrer-policy') === 'no-referrer',
    header('referrer-policy') || 'missing',
  );
  const https = origin.startsWith('https:');
  add(
    'hsts',
    !https || /max-age=\d{7,}/.test(header('strict-transport-security')),
    https ? header('strict-transport-security') || 'missing' : 'not https: skipped',
  );

  // 3. In a browser: nothing from another origin, no console errors, and a valid bundle.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const tab = await context.newPage();
    const offsite: string[] = [];
    const errors: string[] = [];
    tab.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'))
        offsite.push(url);
    });
    tab.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    tab.on('pageerror', (e) => errors.push(e.message));
    let bundle = 'not downloaded';
    let bundleOk = false;
    try {
      await tab.goto(`${origin}/agent/`);
      await tab.getByRole('button', { name: 'Next' }).click();
      await tab.getByLabel('Agent name').fill('deploy-check');
      await tab.getByRole('button', { name: 'Next' }).click();
      await tab.getByLabel('Model id').fill('some-model');
      for (let i = 0; i < 3; i++) await tab.getByRole('button', { name: 'Next' }).click();
      const download = tab.waitForEvent('download');
      await tab.getByRole('button', { name: /^Download kodra-agent-/ }).click();
      const zip = await JSZip.loadAsync(await readFile(await (await download).path()));
      const yaml = await zip.file('kodra-agent-deploy-check/kodra-agent.yaml')?.async('string');
      const parsed = parseAgentConfig(yaml ?? '');
      bundleOk = parsed.ok;
      bundle = parsed.ok
        ? `${String(Object.keys(zip.files).length)} files, kodra-agent.yaml valid`
        : parsed.issues.map((i) => `${i.path} ${i.message}`.trim()).join('; ');
    } catch (error) {
      bundle = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    }
    add('bundle', bundleOk, bundle);
    add(
      'no outside requests',
      offsite.length === 0,
      offsite.length ? offsite.slice(0, 5).join(', ') : 'none',
    );
    add(
      'no console errors',
      errors.length === 0,
      errors.length ? errors.slice(0, 3).join(' | ') : 'none',
    );
  } finally {
    await browser.close();
  }

  // 4. The Build site's home page still answers, and is not the configurator.
  const home = await fetch(`${origin}/`);
  const homeHtml = await home.text();
  add(
    'build home',
    home.status === 200 && !homeHtml.includes('/agent/assets/'),
    `/ answers ${String(home.status)}${homeHtml.includes('/agent/assets/') ? ', but serves the configurator' : ''}`,
  );
  return results;
}
