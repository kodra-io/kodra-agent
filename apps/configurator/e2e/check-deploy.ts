import { checkDeploy } from './deploy-check.ts';

/**
 * pnpm check:deploy <site> (L4): checks a deployed configurator, for example
 *   pnpm check:deploy https://build.dev.kodra.io
 * Exits 1 if any check fails.
 */
const site = process.argv[2];
if (!site || !/^https?:\/\//.test(site)) {
  console.error('Usage: pnpm check:deploy <https://build.kodra.io or the dev site>');
  process.exit(2);
}
const results = await checkDeploy(site);
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(20)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? `All ${String(results.length)} checks passed.`
    : `${String(failed)} check(s) failed.`,
);
process.exitCode = failed === 0 ? 0 : 1;
