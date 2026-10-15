import { describe, expect, it } from 'vitest';
import { fakeServer, json } from '../test-helpers.ts';
import { approverNames, listSlackUsers, matchNames, replaceApproverNames } from './names.ts';

const users = [
  { id: 'U01OMAR', name: 'omar', displayName: 'Omar A' },
  { id: 'U02SARA', name: 'sara.k', displayName: 'sara' },
  { id: 'U03ALEX', name: 'alex1', displayName: 'alex' },
  { id: 'U04ALEX', name: 'alex2', displayName: 'alex' },
];

describe('approverNames', () => {
  it('picks the @names, not ids or console approvers', () => {
    expect(approverNames(['@omar', 'U01OMAR', 'console:omar', '@omar', 'W0GRID'])).toEqual([
      '@omar',
    ]);
  });
});

describe('matchNames', () => {
  it('matches by username or display name, ignoring case', () => {
    const { found, problems } = matchNames(['@Omar', '@sara'], users);
    expect([...found].map(([name, u]) => [name, u.id])).toEqual([
      ['@Omar', 'U01OMAR'],
      ['@sara', 'U02SARA'],
    ]);
    expect(problems).toEqual([]);
  });

  it('matches nobody for an unknown or ambiguous name, and says why', () => {
    const { found, problems } = matchNames(['@nobody', '@alex'], users);
    expect(found.size).toBe(0);
    expect(problems).toEqual([
      '@nobody matches nobody in this Slack workspace.',
      '@alex matches 2 people (U03ALEX, U04ALEX). Use the right user id instead.',
    ]);
  });
});

describe('listSlackUsers', () => {
  it('pages through users.list and leaves out bots and deleted users', async () => {
    const server = await fakeServer({
      'POST /api/users.list': (req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const page2 = new URLSearchParams(body).get('cursor') === 'next';
          json(res, 200, {
            ok: true,
            members: page2
              ? [
                  {
                    id: 'U02',
                    name: 'sara',
                    profile: { display_name: 'Sara', real_name: 'Sara K' },
                  },
                ]
              : [
                  { id: 'U01', name: 'omar', profile: { display_name: 'Omar' } },
                  { id: 'B01', name: 'bot', is_bot: true },
                  { id: 'U09', name: 'gone', deleted: true },
                ],
            response_metadata: { next_cursor: page2 ? '' : 'next' },
          });
        });
      },
    });
    try {
      const found = await listSlackUsers(fetch, 'xoxb-test', server.url);
      expect(found.map((u) => u.id)).toEqual(['U01', 'U02']);
      expect(found[1]).toMatchObject({ displayName: 'Sara', realName: 'Sara K' });
      expect(server.requests[0]?.headers['authorization']).toBe('Bearer xoxb-test');
    } finally {
      await server.close();
    }
  });

  it('fails with what Slack said', async () => {
    const server = await fakeServer({
      'POST /api/users.list': (_req, res) => {
        json(res, 200, { ok: false, error: 'missing_scope' });
      },
    });
    try {
      await expect(listSlackUsers(fetch, 'xoxb-test', server.url)).rejects.toThrow(
        'Slack says missing_scope',
      );
    } finally {
      await server.close();
    }
  });
});

describe('replaceApproverNames', () => {
  it('writes ids in every approver list and keeps comments', () => {
    const text = `spec:
  policy:
    approvals:
      # who approves
      approvers: ['@omar', 'console:omar']
  environments:
    - name: production
      namespaces: [shop]
      approvers:
        - '@sara' # on call
        - U01OMAR
`;
    const out = replaceApproverNames(
      text,
      new Map([
        ['@omar', 'U01OMAR'],
        ['@sara', 'U02SARA'],
      ]),
    );
    expect(out).toContain('# who approves');
    expect(out).toContain("approvers: [ 'U01OMAR', 'console:omar' ]");
    expect(out).toContain("- 'U02SARA' # on call");
    expect(out).not.toContain('@');
  });
});
