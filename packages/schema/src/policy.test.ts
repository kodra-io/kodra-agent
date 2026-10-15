import { describe, expect, it } from 'vitest';
import {
  allApprovers,
  matchEnvironment,
  policyProblems,
  profileDefaults,
  resolvePolicy,
  type EnvironmentInput,
  type PolicySource,
  type Profile,
} from './policy.ts';

function source(
  profile: Profile,
  environments: EnvironmentInput[] = [],
  approvers = ['U01', 'U02'],
): PolicySource {
  return {
    profile,
    policy: { approvals: { approvers, expiresAfterMinutes: 15 } },
    environments,
  };
}

const prod: EnvironmentInput = {
  name: 'production',
  production: true,
  namespaces: ['checkout', 'payments'],
  repos: ['acme/Checkout-API'],
};
const staging: EnvironmentInput = {
  name: 'staging',
  production: false,
  namespaces: ['staging'],
  repos: [],
};

describe('profileDefaults', () => {
  it('matches the profile table', () => {
    expect(profileDefaults('starter', true)).toEqual({ minApprovers: 1, allowSelfApproval: true });
    expect(profileDefaults('team', false)).toEqual({ minApprovers: 1, allowSelfApproval: true });
    expect(profileDefaults('team', true)).toEqual({ minApprovers: 1, allowSelfApproval: false });
    expect(profileDefaults('strict', false)).toEqual({ minApprovers: 1, allowSelfApproval: false });
    expect(profileDefaults('strict', true)).toEqual({ minApprovers: 2, allowSelfApproval: false });
  });
});

describe('resolvePolicy', () => {
  it('applies profile defaults, and environments fall back to the default approvers', () => {
    const effective = resolvePolicy(source('strict', [prod, staging], ['U01', 'U02', 'U03']));
    expect(effective.default).toEqual({
      approvers: ['U01', 'U02', 'U03'],
      minApprovers: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: 15,
    });
    expect(
      effective.environments.map((e) => [e.name, e.minApprovers, e.allowSelfApproval]),
    ).toEqual([
      ['production', 2, false],
      ['staging', 1, false],
    ]);
    expect(effective.environments[0]?.approvers).toEqual(['U01', 'U02', 'U03']);
  });

  it('lets explicit values win over the profile', () => {
    const effective = resolvePolicy({
      ...source('strict', [
        {
          ...prod,
          approvers: ['U09'],
          approvals: { minApprovers: 1, allowSelfApproval: true, expiresAfterMinutes: 5 },
        },
      ]),
      policy: {
        approvals: { approvers: ['U01'], expiresAfterMinutes: 30, allowSelfApproval: true },
      },
    });
    expect(effective.default).toMatchObject({ allowSelfApproval: true, expiresAfterMinutes: 30 });
    expect(effective.environments[0]).toMatchObject({
      approvers: ['U09'],
      minApprovers: 1,
      allowSelfApproval: true,
      expiresAfterMinutes: 5,
    });
  });

  it('lists every approver once', () => {
    const effective = resolvePolicy(
      source('team', [{ ...prod, approvers: ['U02', 'console:omar'] }]),
    );
    expect(allApprovers(effective)).toEqual(['U01', 'U02', 'console:omar']);
  });
});

describe('policyProblems', () => {
  it('accepts a starter config with one approver', () => {
    expect(policyProblems(source('starter', [], ['U01']))).toEqual([]);
  });

  it('refuses production rules nobody can satisfy, with a readable message', () => {
    expect(policyProblems(source('team', [{ ...prod, approvers: ['U01'] }]))).toMatchObject([
      {
        path: ['spec', 'environments', 0, 'approvers'],
        message: 'Production changes need someone other than the requester. Add a second approver.',
      },
    ]);
  });

  it('counts the approvers strict production needs besides the requester', () => {
    expect(policyProblems(source('strict', [prod], ['U01', 'U02']))).toMatchObject([
      {
        path: ['spec', 'environments', 0, 'approvers'],
        message: 'Production changes need 2 approvers other than the requester. List at least 3.',
      },
    ]);
    expect(policyProblems(source('strict', [prod], ['U01', 'U02', 'U03']))).toEqual([]);
  });

  it('refuses the default policy too, and more approvers than are listed', () => {
    expect(policyProblems(source('strict', [], ['U01']))).toMatchObject([
      {
        path: ['spec', 'policy', 'approvals', 'approvers'],
        message: 'Changes need someone other than the requester. Add a second approver.',
      },
    ]);
    const twoNeeded = {
      ...source('starter', [], ['U01']),
      policy: {
        approvals: { approvers: ['U01', 'U01'], expiresAfterMinutes: 15, minApprovers: 2 },
      },
    };
    expect(policyProblems(twoNeeded).map((p) => p.message)).toEqual([
      'Changes need 2 different approvers. List at least 2.',
    ]);
  });

  it('refuses duplicate names, empty environments, and shared namespaces or repos', () => {
    const messages = policyProblems(
      source('starter', [
        prod,
        { ...staging, name: 'production' },
        { ...staging, name: 'shared', namespaces: ['payments'] },
        { name: 'empty', production: false, namespaces: [], repos: [] },
        { name: 'tools', production: false, namespaces: [], repos: ['ACME/checkout-api'] },
      ]),
    ).map((p) => p.message);
    expect(messages).toEqual([
      'production is already the name of another environment.',
      'namespace payments is already in production. A namespace belongs to one environment.',
      'empty needs at least one namespace or repository.',
      'repository ACME/checkout-api is already in production. A repository belongs to one environment.',
    ]);
  });
});

describe('matchEnvironment', () => {
  const effective = resolvePolicy(source('team', [prod, staging]));

  it('uses the default policy for calls outside every environment', () => {
    expect(matchEnvironment(effective, { namespaces: ['tools'], repos: [] })).toMatchObject({
      kind: 'default',
    });
    expect(matchEnvironment(effective, { namespaces: [], repos: [] }).kind).toBe('default');
  });

  it('finds the environment by namespace, or by repo ignoring case', () => {
    const byNamespace = matchEnvironment(effective, { namespaces: ['payments'], repos: [] });
    expect(byNamespace.kind === 'environment' && byNamespace.environment.name).toBe('production');
    const byRepo = matchEnvironment(effective, { namespaces: [], repos: ['acme/checkout-api'] });
    expect(byRepo.kind === 'environment' && byRepo.environment.name).toBe('production');
  });

  it('reports a call that spans two environments, or one and the default', () => {
    expect(matchEnvironment(effective, { namespaces: ['payments', 'staging'], repos: [] })).toEqual(
      { kind: 'conflict', names: ['production', 'staging'] },
    );
    expect(matchEnvironment(effective, { namespaces: ['payments', 'tools'], repos: [] })).toEqual({
      kind: 'conflict',
      names: ['production', 'the default policy'],
    });
  });
});
