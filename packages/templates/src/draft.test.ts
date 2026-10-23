import { describe, expect, it } from 'vitest';
import { decodeDraft, emptyDraft, encodeDraft, splitList } from './draft.ts';
import { composeDraft, kubernetesDraft } from './test-drafts.ts';

function encodeRaw(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `#v1.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

describe('URL hash', () => {
  it.each([
    ['empty', emptyDraft()],
    ['compose', composeDraft()],
    ['kubernetes', kubernetesDraft()],
  ])('round-trips the %s draft', (_name, draft) => {
    expect(decodeDraft(encodeDraft(draft))).toEqual({ ok: true, draft });
  });

  it('keeps non-ASCII text intact', () => {
    const draft = { ...composeDraft(), policy: { ...composeDraft().policy, approvers: '@عمر' } };
    expect(decodeDraft(encodeDraft(draft))).toEqual({ ok: true, draft });
  });

  it('leaves disabled connectors out of the link', () => {
    const draft = composeDraft();
    const github = draft.connectors['github'];
    if (github) github.enabled = false;
    const decoded = decodeDraft(encodeDraft(draft));
    expect(decoded.ok && Object.keys(decoded.draft.connectors)).toEqual([
      'kubernetes',
      'prometheus',
      'slack',
    ]);
  });

  it.each(['', '#', '#v2.abc', '#v1.not base64!', '#v1.e30', `#v1.${'A'.repeat(20_000)}`])(
    'rejects %j',
    (hash) => {
      expect(decodeDraft(hash)).toEqual({ ok: false });
    },
  );

  it('drops unknown connectors, unknown fields, and unknown optional secrets', () => {
    const raw = structuredClone(composeDraft());
    const github = raw.connectors['github'];
    if (!github) throw new Error('fixture needs github');
    (raw.connectors as Record<string, unknown>)['made-up'] = {
      enabled: true,
      access: 'read-only',
      config: {},
      optionalSecrets: [],
    };
    github.config['token'] = 'ghp_ShouldNeverBeKept'; // gitleaks:allow (fake value)
    github.optionalSecrets = ['token', 'nope'];
    raw.model.fields['apiKey'] = 'sk-should-not-survive';
    const decoded = decodeDraft(encodeRaw(raw));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.keys(decoded.draft.connectors)).not.toContain('made-up');
    expect(decoded.draft.connectors['github']?.config).toEqual({ repos: 'acme/payments-api' });
    expect(decoded.draft.connectors['github']?.optionalSecrets).toEqual([]);
    expect(decoded.draft.model.fields).toEqual({ baseUrl: '' });
  });

  it('turns the console and its chat on for links made before they existed', () => {
    const withoutConsole: Partial<ReturnType<typeof composeDraft>> =
      structuredClone(composeDraft());
    delete withoutConsole.console;
    const old = decodeDraft(encodeRaw(withoutConsole));
    expect(old.ok && old.draft.console).toEqual({ enabled: true, chat: true });
    const beforeChat = { ...withoutConsole, console: { enabled: false } };
    const decoded = decodeDraft(encodeRaw(beforeChat));
    expect(decoded.ok && decoded.draft.console).toEqual({ enabled: false, chat: true });
  });

  it('starts links made before profiles as starter, with no environments', () => {
    const raw: Partial<ReturnType<typeof composeDraft>> = structuredClone(composeDraft());
    delete raw.profile;
    delete raw.environments;
    const decoded = decodeDraft(encodeRaw(raw));
    expect(decoded.ok && [decoded.draft.profile, decoded.draft.environments]).toEqual([
      'starter',
      [],
    ]);
  });

  it('keeps the profile and environments in the link', () => {
    const draft = {
      ...composeDraft(),
      profile: 'strict' as const,
      environments: [
        { name: 'production', production: true, namespaces: 'payments', repos: '', approvers: '' },
      ],
    };
    const decoded = decodeDraft(encodeDraft(draft));
    expect(decoded.ok && decoded.draft).toEqual(draft);
  });

  it('falls back to a valid access level', () => {
    const raw = structuredClone(composeDraft());
    const prometheus = raw.connectors['prometheus'];
    if (!prometheus) throw new Error('fixture needs prometheus');
    prometheus.access = 'read-write-approved';
    const decoded = decodeDraft(encodeRaw(raw));
    expect(decoded.ok && decoded.draft.connectors['prometheus']?.access).toBe('read-only');
  });

  it('rejects unexpected top-level keys', () => {
    expect(decodeDraft(encodeRaw({ ...composeDraft(), secrets: { a: 'b' } }))).toEqual({
      ok: false,
    });
  });
});

describe('splitList', () => {
  it('splits on commas, spaces, and new lines', () => {
    expect(splitList(' a, b\nc  d,,')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('daily checks in a shared link', () => {
  it('keeps them, and an older link without them decodes with them off', () => {
    const draft = composeDraft();
    draft.checks = { enabled: true, at: '07:15', days: 'every-day', timezone: 'Europe/Berlin' };
    const decoded = decodeDraft(encodeDraft(draft));
    expect(decoded.ok && decoded.draft.checks).toEqual(draft.checks);

    const older: Partial<ReturnType<typeof composeDraft>> = composeDraft();
    delete older.checks;
    const old = decodeDraft(encodeRaw(older));
    expect(old.ok && old.draft.checks.enabled).toBe(false);
    // A crafted link cannot sneak in a value the page could not produce.
    expect(
      decodeDraft(
        encodeRaw({ ...older, checks: { enabled: true, days: 'hourly', at: '', timezone: '' } }),
      ).ok,
    ).toBe(false);
  });
});
