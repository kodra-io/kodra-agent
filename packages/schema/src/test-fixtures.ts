import { defineManifest, type Manifest } from './manifest.ts';

const text = (en: string) => ({ en, ar: en });

/** Small manifests for unit tests, independent of the real connector catalog. */
export function fixtureManifest(overrides: Partial<Manifest> & Pick<Manifest, 'id'>): Manifest {
  return defineManifest({
    displayName: overrides.id,
    category: 'source',
    status: 'available',
    description: text('fixture'),
    accessLevels: ['read-only', 'read-write-approved'],
    requires: [],
    configFields: [],
    secrets: [],
    tools: {},
    runtime: null,
    permissionsSummary: {
      'read-only': [text('reads')],
      'read-write-approved': [text('writes')],
    },
    ...overrides,
  });
}

export const fixtures = {
  source: fixtureManifest({
    id: 'src',
    configFields: [
      {
        kind: 'string-list',
        key: 'repos',
        required: true,
        description: text('repos'),
        pattern: '^[a-z]+/[a-z]+$',
        patternHint: text('use owner/repo'),
      },
    ],
    secrets: [
      {
        key: 'token',
        envVar: 'SRC_TOKEN',
        defaultRef: 'env',
        required: true,
        description: text('token'),
        howToCreate: text('make one'),
        minimumScopes: {},
        probe: 'src.whoami',
      },
    ],
  }),
  cicd: fixtureManifest({
    id: 'ci',
    category: 'cicd',
    requires: [{ anyOf: [{ category: 'source' }], message: text('ci needs a source connector') }],
  }),
  pinned: fixtureManifest({
    id: 'pinned-ci',
    category: 'cicd',
    requires: [{ anyOf: [{ connector: 'src' }], message: text('pinned-ci needs src') }],
  }),
  monitor: fixtureManifest({
    id: 'mon',
    category: 'monitoring',
    accessLevels: ['read-only'],
    permissionsSummary: { 'read-only': [text('reads')] },
    configFields: [
      { kind: 'url', key: 'url', required: true, description: text('url') },
      {
        kind: 'integer',
        key: 'interval',
        required: true,
        description: text('interval'),
        min: 15,
        max: 3600,
        default: 60,
      },
    ],
  }),
  chat: fixtureManifest({
    id: 'chat',
    category: 'chat',
    accessLevels: [],
    permissionsSummary: { always: [text('talks')] },
  }),
  later: fixtureManifest({
    id: 'later',
    status: 'coming-soon',
    accessLevels: [],
    permissionsSummary: { always: [text('soon')] },
  }),
};

export const fixtureList: readonly Manifest[] = Object.values(fixtures);
