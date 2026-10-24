import { emptyDraft } from '@kodra-agent/templates';
import { describe, expect, it } from 'vitest';
import { reducer } from './state.ts';

describe('reducer toggle', () => {
  it('turns a preview connector on, like a stable one', () => {
    for (const id of ['docker', 'kubernetes']) {
      const draft = reducer(emptyDraft(), { type: 'toggle', id, enabled: true });
      expect(draft.connectors[id]?.enabled).toBe(true);
    }
  });

  it('ignores a coming-soon connector', () => {
    const draft = emptyDraft();
    expect(reducer(draft, { type: 'toggle', id: 'teams', enabled: true })).toBe(draft);
  });
});
