import { connectors } from '@kodra-agent/connectors';
import type { ToolGuard } from '@kodra-agent/schema';
import { describe, expect, it } from 'vitest';
import { decide, type SelfTarget } from './policy.ts';

/**
 * PLAN-v0.2 M11: no connector tool can change the agent's own config, settings ConfigMap,
 * Secret, or Deployment. Kubernetes write tools carry a not-self guard, and this test aims each
 * of them at the agent itself. Every other write-capable tool is listed here with why it cannot
 * reach the agent's objects; a new write tool fails this test until it is classified.
 */
const CANNOT_REACH_SELF: Record<string, string> = {
  github: 'GitHub repositories only; the agent config lives in the bundle folder or the cluster',
  gitlab: 'GitLab projects only',
  'github-actions': 'runs workflows in GitHub, not in the cluster',
  'gitlab-ci': 'runs pipelines in GitLab, not in the cluster',
  grafana: 'Grafana dashboards, alerting, and data sources only',
  aws: 'the EKS server runs without --allow-write and refuses its writes; CloudWatch writes only cancel queries',
};

const SELF: SelfTarget = {
  namespace: 'kodra-agent',
  names: ['shop-agent-kodra-agent', 'shop-agent-secrets'],
};

const OWN_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop-agent-kodra-agent
  namespace: kodra-agent
spec: {}
`;

/** Arguments that aim a guarded tool at the agent's own Deployment or one of its pods. */
function selfArgs(guards: readonly ToolGuard[], name: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const guard of guards) {
    if (guard.kind === 'not-self') {
      args[guard.namespaceArg] = SELF.namespace;
      if (guard.nameArg) args[guard.nameArg] = name;
      if (guard.resourceArg) args[guard.resourceArg] = OWN_DEPLOYMENT;
    }
    if (guard.kind === 'arg-in-setting') args[guard.arg] = SELF.namespace;
  }
  return args;
}

const writeTools = connectors.flatMap((m) =>
  Object.entries(m.tools)
    .filter(([, risk]) => risk !== 'read')
    .map(([tool, risk]) => ({ manifest: m, tool, risk })),
);

describe('the agent cannot change itself', () => {
  it('classifies every write-capable tool', () => {
    const unclassified = writeTools
      .filter(({ manifest, tool }) => {
        const guarded = (manifest.guards?.[tool] ?? []).some((g) => g.kind === 'not-self');
        return !guarded && !(manifest.id in CANNOT_REACH_SELF);
      })
      .map(({ manifest, tool }) => `${manifest.id}/${tool}`);
    expect(unclassified).toEqual([]);
  });

  const guarded = writeTools.filter(({ manifest, tool }) =>
    (manifest.guards?.[tool] ?? []).some((g) => g.kind === 'not-self'),
  );

  it('guards every Kubernetes write tool', () => {
    expect(guarded.map((t) => t.tool).sort()).toEqual([
      'pods_delete',
      'pods_exec',
      'pods_run',
      'resources_create_or_update',
      'resources_delete',
      'resources_scale',
    ]);
  });

  it.each(guarded.map((t) => [`${t.manifest.id}/${t.tool}`, t] as const))(
    '%s cannot reach the agent, with approval and destructive actions allowed',
    (_name, { manifest, tool, risk }) => {
      const guards = manifest.guards?.[tool] ?? [];
      const settings = { namespaces: [SELF.namespace, 'shop'] };
      for (const name of ['shop-agent-kodra-agent', 'shop-agent-kodra-agent-7d9f-x2k4']) {
        const decision = decide({
          risk,
          access: 'read-write-approved',
          destructiveActions: 'require-approval',
          guards,
          args: selfArgs(guards, name),
          settings,
          self: SELF,
        });
        expect(decision).toMatchObject({ kind: 'block' });
        expect(decision.kind === 'block' && decision.reason).toContain('the agent itself');
      }
      // The same tool still works on other workloads.
      const other = selfArgs(guards, 'web');
      for (const guard of guards) {
        if (guard.kind === 'not-self') {
          other[guard.namespaceArg] = 'shop';
          if (guard.resourceArg) {
            other[guard.resourceArg] = OWN_DEPLOYMENT.replaceAll('kodra-agent', 'shop');
          }
        }
        if (guard.kind === 'arg-in-setting') other[guard.arg] = 'shop';
      }
      expect(
        decide({
          risk,
          access: 'read-write-approved',
          destructiveActions: 'require-approval',
          guards,
          args: other,
          settings,
          self: SELF,
        }).kind,
      ).toBe('approve');
    },
  );

  it('treats a missing namespace as the agent namespace, and an unreadable manifest as unsafe', () => {
    const guards: ToolGuard[] = [
      { kind: 'not-self', namespaceArg: 'namespace', resourceArg: 'resource' },
    ];
    const base = {
      risk: 'destructive' as const,
      access: 'read-write-approved' as const,
      destructiveActions: 'require-approval' as const,
      guards,
      settings: {},
      self: SELF,
    };
    const noNamespace = OWN_DEPLOYMENT.replace('  namespace: kodra-agent\n', '');
    expect(decide({ ...base, args: { resource: noNamespace } }).kind).toBe('block');
    expect(decide({ ...base, args: { resource: 'kind: [' } })).toEqual({
      kind: 'block',
      reason: 'cannot tell which objects this changes, so it is blocked',
    });
    // Outside a cluster there is no agent object to protect.
    expect(decide({ ...base, self: null, args: { resource: OWN_DEPLOYMENT } }).kind).toBe(
      'approve',
    );
  });
});
