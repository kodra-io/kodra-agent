import { CHECK_TITLES, type Finding } from './rules.ts';
import type { Digest } from './state.ts';

/** Nothing open, nothing fixed, nothing that could not be checked. */
export function isClean(d: Digest): boolean {
  return (
    d.fresh.length === 0 && d.ongoing.length === 0 && d.resolved.length === 0 && d.gaps.length === 0
  );
}

const line = (f: Finding, since?: string) =>
  `• ${f.severity === 'critical' ? '[critical] ' : ''}${f.title} (${f.where})${since ? `, since ${since.slice(0, 10)}` : ''}`;

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * The digest as Slack text (also printed by `kodra-agent check`). Built from parsed fields
 * only; the caller still redacts it before it leaves.
 */
export function digestText(d: Digest): string {
  const open = d.fresh.length + d.ongoing.length;
  const head = `*Checks* (${d.trigger}, ${d.at.slice(0, 16).replace('T', ' ')} UTC): `;
  const summary =
    open === 0 && d.gaps.length === 0
      ? `everything checked is fine${d.resolved.length > 0 ? `, and ${plural(d.resolved.length, 'problem')} fixed since last time` : ''}.`
      : `${String(d.fresh.length)} new, ${String(d.ongoing.length)} still broken, ${String(d.resolved.length)} fixed.`;
  const sections: string[] = [head + summary];
  const order = (items: Finding[]) =>
    [...items].sort((a, b) =>
      a.severity === b.severity
        ? a.check.localeCompare(b.check)
        : a.severity === 'critical'
          ? -1
          : 1,
    );
  if (d.fresh.length > 0)
    sections.push(['*New*', ...order(d.fresh).map((f) => line(f))].join('\n'));
  if (d.ongoing.length > 0) {
    sections.push(
      [
        '*Still broken*',
        ...order(d.ongoing).map((f) => line(f, (f as Finding & { since: string }).since)),
      ].join('\n'),
    );
  }
  if (d.resolved.length > 0) {
    sections.push(['*Fixed since last time*', ...d.resolved.map((f) => line(f))].join('\n'));
  }
  if (d.gaps.length > 0) {
    sections.push(
      [
        '*Could not check*',
        ...d.gaps.map((g) => `• ${CHECK_TITLES[g.check]} in ${g.where}: ${g.reason}`),
      ].join('\n'),
    );
  }
  const footer = [
    `Checked: ${d.ran.map((c) => CHECK_TITLES[c].toLowerCase()).join(', ') || 'nothing'}.`,
    ...(d.skipped.length > 0
      ? [
          `Not checked (connector off or nothing listed): ${d.skipped.map((c) => CHECK_TITLES[c].toLowerCase()).join(', ')}.`,
        ]
      : []),
    ...(d.auditHead
      ? [`Audit log head: #${String(d.auditHead.seq)} ${d.auditHead.hash.slice(0, 16)}.`]
      : []),
  ];
  sections.push(footer.join('\n'));
  return sections.join('\n\n');
}
