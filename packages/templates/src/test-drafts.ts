import { getConnector } from '@kodra-agent/connectors';
import { connectorDefaults, emptyDraft, type AgentDraft, type ConnectorDraft } from './draft.ts';

export function withConnector(
  draft: AgentDraft,
  id: string,
  overrides: Partial<ConnectorDraft> = {},
): AgentDraft {
  const manifest = getConnector(id);
  if (!manifest) throw new Error(`unknown connector ${id}`);
  const base = connectorDefaults(manifest, draft.target);
  return {
    ...draft,
    connectors: {
      ...draft.connectors,
      [id]: { ...base, ...overrides, config: { ...base.config, ...overrides.config } },
    },
  };
}

/** The SPEC section 5 example, as the configurator would build it. */
export function composeDraft(): AgentDraft {
  let draft: AgentDraft = {
    ...emptyDraft(),
    name: 'payments-team-agent',
    model: { provider: 'anthropic', name: 'some-model', fields: { baseUrl: '' } },
    policy: { approvers: '@omar', expiresAfterMinutes: '15', destructiveActions: 'deny' },
  };
  draft = withConnector(draft, 'github', {
    access: 'read-write-approved',
    config: { repos: 'acme/payments-api' },
  });
  draft = withConnector(draft, 'kubernetes', { config: { namespaces: 'payments' } });
  draft = withConnector(draft, 'prometheus', {
    config: { url: 'http://prometheus.monitoring:9090' },
  });
  draft = withConnector(draft, 'slack', { config: { channel: '#payments-ops' } });
  return draft;
}

export function kubernetesDraft(
  access: 'read-only' | 'read-write-approved' = 'read-only',
): AgentDraft {
  let draft: AgentDraft = {
    ...emptyDraft(),
    name: 'platform-agent',
    target: 'kubernetes',
    model: { provider: 'bedrock', name: 'some-model', fields: { region: 'eu-central-1' } },
    policy: {
      approvers: '@omar, U0123ABCD',
      expiresAfterMinutes: '30',
      destructiveActions: 'deny',
    },
  };
  draft = withConnector(draft, 'gitlab', { config: { projects: 'acme/platform/api' } });
  draft = withConnector(draft, 'gitlab-ci');
  draft = withConnector(draft, 'kubernetes', { access, config: { namespaces: 'api, web' } });
  return draft;
}
