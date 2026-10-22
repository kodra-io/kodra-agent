import type { Analysis } from './analyze.ts';

const code = (s: string) => `\`${s}\``;

/** Steps a DevOps engineer takes next that the agent does not do yet. */
export const NOT_YET = [
  'Deploy to a first environment and watch the rollout.',
  'Scrape metrics, add alerts, and a dashboard for this service.',
  'Scan dependencies and the image for known vulnerabilities.',
  'Write a runbook: how to deploy, roll back, and where the logs are.',
];

/**
 * The onboarding report as Markdown: printed in the terminal and committed as ONBOARDING.md.
 * Built from the analysis only, so it never holds a secret value.
 */
export function onboardingReport(repo: string, a: Analysis): string {
  const lines: string[] = [
    `# Onboarding: ${repo}`,
    '',
    'Kodra AI Agent read this repository to work out what it needs to run in production.',
    'It read files only: nothing was run, and no secret value was kept.',
    '',
    '## The app',
    ...(a.detection.ok
      ? a.detection.detection.notes.map((n) => `- ${n}`)
      : [`- ${a.detection.reason}`]),
  ];
  if (a.services.length > 1) {
    lines.push('', '## Services in this repo', ...a.services.map((s) => `- ${code(s)}`));
  }
  lines.push(
    '',
    '## What it depends on',
    ...(a.dependencies.length > 0
      ? a.dependencies.map(
          (d) => `- ${d.name} (${d.kind}), from ${d.evidence.map(code).join(', ')}`,
        )
      : ['- Nothing found in the dependency files.']),
    '',
    '## Settings it reads',
  );
  if (a.config.length > 0) {
    lines.push(
      '| Variable | Kind | Read in |',
      '| --- | --- | --- |',
      ...a.config.map(
        (v) =>
          `| ${code(v.name)} | ${v.secret ? 'secret' : 'setting'} | ${v.files.map(code).join(', ')} |`,
      ),
    );
  } else {
    lines.push('- No environment variables found.');
  }
  lines.push(
    '',
    '## Database migrations',
    ...(a.migrations.length > 0 ? a.migrations.map((m) => `- ${m}`) : ['- None found.']),
    '',
    '## Tests',
    `- ${a.tests ? `Run with ${code(a.tests)}.` : 'None found.'}`,
  );
  if (a.secrets.length > 0) {
    lines.push(
      '',
      '## Committed credentials',
      'The values are not shown here. Rotate each one: deleting the file leaves it in git history.',
      ...a.secrets.map((h) => `- ${code(`${h.path}:${String(h.line)}`)} (${h.rule})`),
    );
  }
  const risks = a.findings.filter((f) => f.level === 'risk');
  const gaps = a.findings.filter((f) => f.level === 'gap');
  if (risks.length > 0) lines.push('', '## Risks', ...risks.map((f) => `- ${f.text}`));
  if (gaps.length > 0) lines.push('', '## Gaps', ...gaps.map((f) => `- ${f.text}`));
  lines.push(
    '',
    '## Questions for the team',
    ...a.questions.map((q, i) => `${String(i + 1)}. ${q}`),
    '',
    '## Next steps the agent does not do yet',
    ...NOT_YET.map((s) => `- ${s}`),
    '',
  );
  return lines.join('\n');
}
