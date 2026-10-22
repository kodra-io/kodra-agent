import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS } from '../shared.ts';

const readSummary = 'Lists local images and containers and reads build logs.';

export default defineManifest({
  id: 'docker',
  displayName: 'Docker',
  category: 'build',
  status: 'available',
  description: 'Inspect images and containers. With write access, build images for the ship flow.',
  accessLevels: ['read-only', 'read-write-approved'],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'socketPath',
      required: true,
      description: 'Path to the Docker socket.',
      pattern: PATTERNS.absolutePath,
      patternHint: 'must be an absolute path',
      default: '/var/run/docker.sock',
    },
  ],
  secrets: [],
  healthProbe: 'docker.ping',
  tools: {},
  runtime: null,
  permissionsSummary: {
    'read-only': [readSummary],
    'read-write-approved': [
      readSummary,
      'Builds images through the Docker socket after you approve.',
      'Docker socket access is close to full control of that machine. Enable it only on a machine meant for builds.',
    ],
  },
});
