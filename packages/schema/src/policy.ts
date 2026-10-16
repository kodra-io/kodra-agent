/**
 * Profiles and environments (PLAN-v0.2 section 3). A profile sets defaults suited to a kind of
 * organization; every value can still be set explicitly. `resolvePolicy` is the only place
 * those defaults live: the configurator, `doctor`, and the agent all call it.
 */
import type { FreezeInput } from './freeze.ts';

export const PROFILES = ['starter', 'team', 'strict'] as const;
export type Profile = (typeof PROFILES)[number];

/**
 * What happens when a console save changes policy (M11): it is audited, also announced to all
 * approvers with the diff, or it waits for a second approver before it applies.
 */
export type PolicyChanges = 'audited' | 'announced' | 'second-approver';

export interface ApprovalRuleInput {
  minApprovers?: number | undefined;
  allowSelfApproval?: boolean | undefined;
  expiresAfterMinutes?: number | undefined;
  requireChangeRef?: boolean | undefined;
  changeRefPattern?: string | undefined;
}

export interface EnvironmentInput {
  name: string;
  production: boolean;
  namespaces: readonly string[];
  repos: readonly string[];
  approvers?: readonly string[] | undefined;
  approvals?: ApprovalRuleInput | undefined;
  freezes?: readonly FreezeInput[] | undefined;
  /** A name from spec.models this environment's data goes to (M13). */
  model?: string | undefined;
}

/** The parts of `spec` the policy comes from. */
export interface PolicySource {
  profile: Profile;
  policy: {
    approvals: { approvers: readonly string[]; expiresAfterMinutes: number } & ApprovalRuleInput;
  };
  environments: readonly EnvironmentInput[];
}

/** What one approval needs, after profile defaults and explicit values. */
export interface ApprovalRules {
  approvers: string[];
  minApprovers: number;
  allowSelfApproval: boolean;
  expiresAfterMinutes: number;
  /** Approving needs a change reference (a ticket number), checked against the pattern if set. */
  requireChangeRef: boolean;
  changeRefPattern: string | null;
}

export interface EffectiveEnvironment extends ApprovalRules {
  name: string;
  production: boolean;
  namespaces: string[];
  repos: string[];
  freezes: FreezeInput[];
  /** The named model this environment's data goes to, or null for the default model. */
  model: string | null;
}

export interface EffectivePolicy {
  profile: Profile;
  /** For anything outside every environment. */
  default: ApprovalRules;
  environments: EffectiveEnvironment[];
  policyChanges: PolicyChanges;
}

const POLICY_CHANGES: Record<Profile, PolicyChanges> = {
  starter: 'audited',
  team: 'announced',
  strict: 'second-approver',
};

/** The profile's defaults for one set of rules. Production only matters for team and strict. */
export function profileDefaults(
  profile: Profile,
  production: boolean,
): { minApprovers: number; allowSelfApproval: boolean; requireChangeRef: boolean } {
  switch (profile) {
    case 'starter':
      return { minApprovers: 1, allowSelfApproval: true, requireChangeRef: false };
    case 'team':
      return { minApprovers: 1, allowSelfApproval: !production, requireChangeRef: false };
    case 'strict':
      return {
        minApprovers: production ? 2 : 1,
        allowSelfApproval: false,
        requireChangeRef: production,
      };
  }
}

/** Profile defaults first, then explicit values. Environments fall back to the default approvers. */
export function resolvePolicy(source: PolicySource): EffectivePolicy {
  const base = source.policy.approvals;
  const defaults = profileDefaults(source.profile, false);
  return {
    profile: source.profile,
    default: {
      approvers: [...base.approvers],
      minApprovers: base.minApprovers ?? defaults.minApprovers,
      allowSelfApproval: base.allowSelfApproval ?? defaults.allowSelfApproval,
      expiresAfterMinutes: base.expiresAfterMinutes,
      requireChangeRef: base.requireChangeRef ?? defaults.requireChangeRef,
      changeRefPattern: base.changeRefPattern ?? null,
    },
    policyChanges: POLICY_CHANGES[source.profile],
    environments: source.environments.map((env) => {
      const d = profileDefaults(source.profile, env.production);
      return {
        name: env.name,
        production: env.production,
        namespaces: [...env.namespaces],
        repos: [...env.repos],
        approvers: [...(env.approvers ?? base.approvers)],
        minApprovers: env.approvals?.minApprovers ?? d.minApprovers,
        allowSelfApproval: env.approvals?.allowSelfApproval ?? d.allowSelfApproval,
        expiresAfterMinutes: env.approvals?.expiresAfterMinutes ?? base.expiresAfterMinutes,
        requireChangeRef: env.approvals?.requireChangeRef ?? d.requireChangeRef,
        changeRefPattern: env.approvals?.changeRefPattern ?? null,
        freezes: [...(env.freezes ?? [])],
        model: env.model ?? null,
      };
    }),
  };
}

/** Every approver named anywhere: the default list and each environment's, once each. */
export function allApprovers(policy: EffectivePolicy): string[] {
  return [
    ...new Set([...policy.default.approvers, ...policy.environments.flatMap((e) => e.approvers)]),
  ];
}

/** What is wrong, as a code the configurator translates, with the values it names. */
export type PolicyProblemCode =
  | 'duplicate-name'
  | 'empty-environment'
  | 'namespace-taken'
  | 'repo-taken'
  | 'needs-other-approver'
  | 'needs-more-approvers';

export interface PolicyProblem {
  path: (string | number)[];
  code: PolicyProblemCode;
  /**
   * `scope` is production, environment (with `name`), or default; the rest depends on the code:
   * name, namespace, repo, owner, min (approvers needed), list (approvers to list).
   */
  vars: Record<string, string | number>;
  /** In English, for `doctor` and the agent. */
  message: string;
}

function whose(env: EffectiveEnvironment | null): string {
  if (!env) return 'Changes';
  return env.production ? 'Production changes' : `Changes in ${env.name}`;
}

/** Rules nobody can satisfy: too few approvers for the number needed. */
function unsatisfiable(
  rules: ApprovalRules,
  env: EffectiveEnvironment | null,
  path: (string | number)[],
): PolicyProblem | null {
  const distinct = new Set(rules.approvers).size;
  const min = rules.minApprovers;
  // The requester may be an approver, so without self-approval one more is needed.
  const list = rules.allowSelfApproval ? min : min + 1;
  if (distinct >= list) return null;
  const scope = env ? (env.production ? 'production' : 'environment') : 'default';
  const vars = { scope, name: env?.name ?? '', min, list, self: rules.allowSelfApproval ? 1 : 0 };
  if (!rules.allowSelfApproval && min === 1) {
    return {
      path,
      code: 'needs-other-approver',
      vars,
      message: `${whose(env)} need someone other than the requester. Add a second approver.`,
    };
  }
  return {
    path,
    code: 'needs-more-approvers',
    vars,
    message: rules.allowSelfApproval
      ? `${whose(env)} need ${String(min)} different approvers. List at least ${String(min)}.`
      : `${whose(env)} need ${String(min)} approvers other than the requester. List at least ${String(list)}.`,
  };
}

/**
 * Everything wrong with the profile, environments, and approval rules, phrased for the person
 * editing them. Paths point into `spec`.
 */
export function policyProblems(source: PolicySource): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const names = new Map<string, number>();
  const namespaces = new Map<string, string>();
  const repos = new Map<string, string>();
  source.environments.forEach((env, i) => {
    const at = (key: string) => ['spec', 'environments', i, key];
    const first = names.get(env.name);
    if (first !== undefined) {
      problems.push({
        path: at('name'),
        code: 'duplicate-name',
        vars: { name: env.name },
        message: `${env.name} is already the name of another environment.`,
      });
    } else {
      names.set(env.name, i);
    }
    if (env.namespaces.length === 0 && env.repos.length === 0) {
      problems.push({
        path: at('namespaces'),
        code: 'empty-environment',
        vars: { name: env.name },
        message: `${env.name} needs at least one namespace or repository.`,
      });
    }
    for (const ns of env.namespaces) {
      const owner = namespaces.get(ns);
      if (owner !== undefined && owner !== env.name) {
        problems.push({
          path: at('namespaces'),
          code: 'namespace-taken',
          vars: { namespace: ns, owner },
          message: `namespace ${ns} is already in ${owner}. A namespace belongs to one environment.`,
        });
      } else {
        namespaces.set(ns, env.name);
      }
    }
    for (const repo of env.repos) {
      const key = repo.toLowerCase();
      const owner = repos.get(key);
      if (owner !== undefined && owner !== env.name) {
        problems.push({
          path: at('repos'),
          code: 'repo-taken',
          vars: { repo, owner },
          message: `repository ${repo} is already in ${owner}. A repository belongs to one environment.`,
        });
      } else {
        repos.set(key, env.name);
      }
    }
  });

  const effective = resolvePolicy(source);
  const base = unsatisfiable(effective.default, null, ['spec', 'policy', 'approvals', 'approvers']);
  if (base) problems.push(base);
  effective.environments.forEach((env, i) => {
    const problem = unsatisfiable(env, env, ['spec', 'environments', i, 'approvers']);
    if (problem) problems.push(problem);
  });
  return problems;
}

/** Where a tool call lands: the default policy, one environment, or more than one (refused). */
export type EnvironmentMatch =
  | { kind: 'default'; rules: ApprovalRules }
  | { kind: 'environment'; environment: EffectiveEnvironment }
  | { kind: 'conflict'; names: string[] };

/**
 * The environment of a set of namespaces and repos a call (or a proposed change) touches. Repos
 * compare case-insensitively, like the repo guards. Nothing matched means the default policy.
 */
export function matchEnvironment(
  policy: EffectivePolicy,
  touched: { namespaces: readonly string[]; repos: readonly string[] },
): EnvironmentMatch {
  const hits = new Map<string, EffectiveEnvironment>();
  for (const env of policy.environments) {
    const repos = env.repos.map((r) => r.toLowerCase());
    if (
      touched.namespaces.some((ns) => env.namespaces.includes(ns)) ||
      touched.repos.some((r) => repos.includes(r.toLowerCase()))
    ) {
      hits.set(env.name, env);
    }
  }
  const matched = [...hits.values()];
  const only = matched.length === 1 ? matched[0] : undefined;
  if (only) {
    // Something outside the environment as well as inside it spans two policies.
    const outside =
      touched.namespaces.some((ns) => !only.namespaces.includes(ns)) ||
      touched.repos.some((r) => !only.repos.some((o) => o.toLowerCase() === r.toLowerCase()));
    return outside
      ? { kind: 'conflict', names: [only.name, 'the default policy'] }
      : { kind: 'environment', environment: only };
  }
  if (matched.length > 1) return { kind: 'conflict', names: matched.map((e) => e.name) };
  return { kind: 'default', rules: policy.default };
}

/** The customer data the profile masks by default (M13): payment data always, contacts in team and strict. */
export function defaultDetectors(profile: Profile): ('cards' | 'ibans' | 'emails' | 'phones')[] {
  return profile === 'starter' ? ['cards', 'ibans'] : ['cards', 'ibans', 'emails', 'phones'];
}

/**
 * The environments with a pinned model that a call touches (M13). A call that names no
 * namespace or repo (a list across every namespace, a metrics query) may return data from
 * any of them, so it touches every one.
 */
export function pinnedEnvironments(
  policy: EffectivePolicy,
  touched: { namespaces: readonly string[]; repos: readonly string[] },
): EffectiveEnvironment[] {
  const pinned = policy.environments.filter((e) => e.model !== null);
  if (touched.namespaces.length === 0 && touched.repos.length === 0) return pinned;
  return pinned.filter(
    (e) =>
      touched.namespaces.some((ns) => e.namespaces.includes(ns)) ||
      touched.repos.some((r) => e.repos.some((o) => o.toLowerCase() === r.toLowerCase())),
  );
}
