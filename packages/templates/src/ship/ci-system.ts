import type { Existing } from './detect.ts';

/** Where the source lives; null for a local folder. */
export type SourceProvider = 'github' | 'gitlab';

/** The CI tools ship can write a pipeline for (B5). Each is also a connector id. */
export const CI_SYSTEMS = ['github-actions', 'gitlab-ci', 'jenkins'] as const;
export type CiSystem = (typeof CI_SYSTEMS)[number];

const NAMES: Record<CiSystem, string> = {
  'github-actions': 'GitHub Actions',
  'gitlab-ci': 'GitLab CI',
  jenkins: 'Jenkins',
};
export const ciName = (ci: CiSystem) => NAMES[ci];

/** The CI that comes with the repo's host. */
export const hostCi = (provider: SourceProvider | null): CiSystem | null =>
  provider === 'github' ? 'github-actions' : provider === 'gitlab' ? 'gitlab-ci' : null;

/** GitHub Actions builds only GitHub repos and GitLab CI only GitLab ones; Jenkins builds any. */
export const canBuild = (ci: CiSystem, provider: SourceProvider | null) =>
  ci === 'jenkins' || ci === hostCi(provider);

export interface CiChoiceInput {
  /** `spec.ship.ci`. */
  setting: CiSystem | 'auto';
  provider: SourceProvider | null;
  existing: Pick<Existing, 'githubCi' | 'gitlabCi' | 'jenkinsfile'>;
  /** The CI connectors that are turned on. */
  connected: readonly CiSystem[];
}

export interface CiChoice {
  /** null: no CI is written (a local folder with no CI connector). */
  ci: CiSystem | null;
  /** One sentence on why, for the terminal and the PR. */
  reason: string;
}

/**
 * Which CI tool builds the repo: the setting, else the CI the repo already has, else the CI
 * connector that is turned on, else the CI that comes with the repo's host.
 */
export function chooseCi(i: CiChoiceInput): CiChoice {
  const where = i.provider === 'github' ? 'GitHub' : i.provider === 'gitlab' ? 'GitLab' : 'local';
  let note = '';
  if (i.setting !== 'auto') {
    if (canBuild(i.setting, i.provider)) {
      return { ci: i.setting, reason: `spec.ship.ci is ${i.setting}.` };
    }
    note = `spec.ship.ci is ${i.setting}, which cannot build a ${where} repo. `;
  }
  const present = (
    [
      ['github-actions', i.existing.githubCi],
      ['gitlab-ci', i.existing.gitlabCi],
      ['jenkins', i.existing.jenkinsfile],
    ] as const
  )
    .filter(([ci, has]) => has && canBuild(ci, i.provider))
    .map(([ci]) => ci);
  const repoCi = present.find((ci) => i.connected.includes(ci)) ?? present[0];
  if (repoCi) {
    return { ci: repoCi, reason: `${note}The repo already builds with ${ciName(repoCi)}.` };
  }
  const usable = CI_SYSTEMS.filter((ci) => i.connected.includes(ci) && canBuild(ci, i.provider));
  const own = hostCi(i.provider);
  const [only] = usable;
  if (usable.length === 1 && only) {
    return { ci: only, reason: `${note}${ciName(only)} is the CI connector that is turned on.` };
  }
  if (usable.length > 1) {
    const ci = own && usable.includes(own) ? own : (only ?? 'jenkins');
    return {
      ci,
      reason: `${note}Several CI connectors are on (${usable.map(ciName).join(', ')}), so ${ciName(ci)} was used. Set spec.ship.ci to choose.`,
    };
  }
  if (own) {
    return {
      ci: own,
      reason: `${note}No CI connector is turned on, so the CI that comes with ${where} is used.`,
    };
  }
  return { ci: null, reason: `${note}No CI connector is turned on, so no pipeline is written.` };
}
