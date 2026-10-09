import { getConnector } from '@kodra-agent/connectors';
import type { AccessLevel, ModelProvider } from '@kodra-agent/schema';
import {
  connectorDefaults,
  decodeDraft,
  defaultOptionalSecrets,
  emptyDraft,
  encodeDraft,
  modelFieldDefaults,
  type AgentDraft,
  type DestructivePolicy,
  type Target,
} from '@kodra-agent/templates';
import { useEffect, useReducer, useState } from 'react';

export type Action =
  | { type: 'name'; value: string }
  | { type: 'target'; value: Target }
  | { type: 'provider'; value: ModelProvider }
  | { type: 'modelName'; value: string }
  | { type: 'modelField'; key: string; value: string }
  | { type: 'toggle'; id: string; enabled: boolean }
  | { type: 'access'; id: string; value: AccessLevel }
  | { type: 'connectorField'; id: string; key: string; value: string }
  | { type: 'optionalSecret'; id: string; key: string; included: boolean }
  | { type: 'approvers'; value: string }
  | { type: 'expires'; value: string }
  | { type: 'destructive'; value: DestructivePolicy }
  | { type: 'console'; enabled: boolean };

export function reducer(draft: AgentDraft, action: Action): AgentDraft {
  switch (action.type) {
    case 'name':
      return { ...draft, name: action.value };
    case 'target': {
      // Optional secrets that depend on the target (like a kubeconfig file) follow it.
      const connectors = Object.fromEntries(
        Object.entries(draft.connectors).map(([id, entry]) => {
          const manifest = getConnector(id);
          return [
            id,
            manifest
              ? { ...entry, optionalSecrets: defaultOptionalSecrets(manifest, action.value) }
              : entry,
          ];
        }),
      );
      return { ...draft, target: action.value, connectors };
    }
    case 'provider':
      return {
        ...draft,
        model: { ...draft.model, provider: action.value, fields: modelFieldDefaults(action.value) },
      };
    case 'modelName':
      return { ...draft, model: { ...draft.model, name: action.value } };
    case 'modelField':
      return {
        ...draft,
        model: { ...draft.model, fields: { ...draft.model.fields, [action.key]: action.value } },
      };
    case 'toggle': {
      const manifest = getConnector(action.id);
      if (!manifest || manifest.status !== 'available') return draft;
      const existing = draft.connectors[action.id];
      const entry = existing
        ? { ...existing, enabled: action.enabled }
        : { ...connectorDefaults(manifest, draft.target), enabled: action.enabled };
      return { ...draft, connectors: { ...draft.connectors, [action.id]: entry } };
    }
    case 'access':
      return updateConnector(draft, action.id, (c) => ({ ...c, access: action.value }));
    case 'connectorField':
      return updateConnector(draft, action.id, (c) => ({
        ...c,
        config: { ...c.config, [action.key]: action.value },
      }));
    case 'optionalSecret':
      return updateConnector(draft, action.id, (c) => ({
        ...c,
        optionalSecrets: action.included
          ? [...new Set([...c.optionalSecrets, action.key])]
          : c.optionalSecrets.filter((k) => k !== action.key),
      }));
    case 'approvers':
      return { ...draft, policy: { ...draft.policy, approvers: action.value } };
    case 'expires':
      return { ...draft, policy: { ...draft.policy, expiresAfterMinutes: action.value } };
    case 'destructive':
      return { ...draft, policy: { ...draft.policy, destructiveActions: action.value } };
    case 'console':
      return { ...draft, console: { enabled: action.enabled } };
  }
}

function updateConnector(
  draft: AgentDraft,
  id: string,
  update: (c: AgentDraft['connectors'][string]) => AgentDraft['connectors'][string],
): AgentDraft {
  const entry = draft.connectors[id];
  return entry ? { ...draft, connectors: { ...draft.connectors, [id]: update(entry) } } : draft;
}

function initialState(): { draft: AgentDraft; invalidLink: boolean } {
  const hash = window.location.hash;
  if (!hash) return { draft: emptyDraft(), invalidLink: false };
  const decoded = decodeDraft(hash);
  return decoded.ok
    ? { draft: decoded.draft, invalidLink: false }
    : { draft: emptyDraft(), invalidLink: true };
}

/** Draft state, mirrored into the URL hash so a setup can be shared as a link. */
export function useDraft() {
  const [initial] = useState(initialState);
  const [draft, dispatch] = useReducer(reducer, initial.draft);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const url = `${window.location.pathname}${window.location.search}${encodeDraft(draft)}`;
      window.history.replaceState(null, '', url);
    }, 150);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft]);

  return { draft, dispatch, invalidLink: initial.invalidLink };
}
