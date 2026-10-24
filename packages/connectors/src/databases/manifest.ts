import { defineManifest } from '@kodra-agent/schema';
import { HOST_KEY_STEPS, HOST_STEPS, PASSWORD_STEPS, TUNNEL_KEY_STEPS } from './steps.ts';

/** A host name or an IP address (v4, or v6 in brackets or plain). */
const HOST =
  '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\\[?[0-9A-Fa-f:.]+\\]?)$';

export default defineManifest({
  id: 'databases',
  displayName: 'Databases',
  category: 'database',
  status: 'preview',
  description:
    'Watch the databases you list, wherever they run: standalone, in the cloud (like Amazon RDS), or in Kubernetes. MariaDB, MySQL, and PostgreSQL, directly or through an SSH tunnel. Health checks only.',
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'entries',
      key: 'databases',
      required: false,
      description: 'The databases to watch. Use a database user that can only read.',
      noun: 'database',
      envPrefix: 'KODRA_DB_',
      max: 20,
      fields: [
        {
          kind: 'choice',
          key: 'engine',
          required: true,
          description: 'Database engine.',
          options: ['mariadb', 'mysql', 'postgres'],
        },
        {
          kind: 'string',
          key: 'host',
          required: true,
          description: 'Host name or IP address, as seen from the agent (or from the tunnel host).',
          pattern: HOST,
          patternHint: 'use a host name or an IP address',
          example: 'orders.abc123.eu-central-1.rds.amazonaws.com',
          steps: HOST_STEPS,
        },
        {
          kind: 'integer',
          key: 'port',
          required: false,
          description: 'Port. Leave empty for the engine default (3306 or 5432).',
          min: 1,
          max: 65535,
        },
        {
          kind: 'string',
          key: 'database',
          required: false,
          description: 'Database to connect to. PostgreSQL uses postgres when empty.',
          pattern: '^[A-Za-z0-9_$-]{1,63}$',
          patternHint: 'use letters, digits, _, $, and -',
        },
        {
          kind: 'string',
          key: 'user',
          required: true,
          description: 'Database user.',
          pattern: '^[A-Za-z0-9_.@-]{1,63}$',
          patternHint: 'use letters, digits, and _ . @ -',
          example: 'kodra_monitor',
        },
        {
          kind: 'secret',
          key: 'password',
          required: false,
          description: 'The database user’s password.',
          howToCreate:
            'Create a user that can only read server status (see docs/connectors/databases.md for the grant per engine), then enter its password here. It is tested before it is saved.',
          envVar: 'PASSWORD',
          steps: PASSWORD_STEPS,
        },
        {
          kind: 'choice',
          key: 'tls',
          required: false,
          description:
            'Encryption: verify (encrypted, certificate checked), require (encrypted, certificate not checked), or off.',
          options: ['verify', 'require', 'off'],
          default: 'verify',
        },
        {
          kind: 'string',
          key: 'tunnelHost',
          required: false,
          description:
            'SSH tunnel: the bastion host to connect through. Leave empty to connect directly.',
          pattern: HOST,
          patternHint: 'use a host name or an IP address',
          example: 'bastion.example.com',
        },
        {
          kind: 'integer',
          key: 'tunnelPort',
          required: false,
          description: 'SSH tunnel: the bastion’s SSH port.',
          min: 1,
          max: 65535,
          default: 22,
        },
        {
          kind: 'string',
          key: 'tunnelUser',
          required: false,
          requiredWith: 'tunnelHost',
          description: 'SSH tunnel: the user on the bastion.',
          pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$',
          patternHint: 'use a Linux user name',
        },
        {
          kind: 'string',
          key: 'tunnelHostKey',
          required: false,
          requiredWith: 'tunnelHost',
          description:
            'SSH tunnel: the bastion’s host key fingerprint. The tunnel is refused if it does not match.',
          pattern: '^SHA256:[A-Za-z0-9+/]{43}=?$',
          patternHint:
            'use a SHA256 fingerprint, like SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
          steps: HOST_KEY_STEPS,
        },
        {
          kind: 'secret',
          key: 'tunnelKey',
          required: false,
          requiredWith: 'tunnelHost',
          description: 'SSH tunnel: the private key for the bastion user.',
          howToCreate:
            'Make a key just for this (ssh-keygen -t ed25519), and limit it on the bastion to port forwarding to this database: in authorized_keys, restrict,port-forwarding,permitopen="db-host:port". Paste the private key here.',
          envVar: 'TUNNEL_KEY',
          format: 'ssh-private-key',
          steps: TUNNEL_KEY_STEPS,
        },
        {
          kind: 'integer',
          key: 'maxLagSeconds',
          required: false,
          description: 'A replica this many seconds behind is not fully healthy.',
          min: 1,
          max: 86400,
          default: 30,
        },
        {
          kind: 'integer',
          key: 'connectionsWarnPercent',
          required: false,
          description:
            'Connections in use, as a percentage of the maximum, at which the database is not fully healthy.',
          min: 1,
          max: 100,
          default: 90,
        },
      ],
    },
  ],
  secrets: [],
  healthProbe: 'databases.connect',
  tools: {
    list_databases: 'read',
    database_health: 'read',
  },
  guards: {
    database_health: [
      { kind: 'arg-in-setting', arg: 'database', setting: 'databases', required: true },
    ],
  },
  dashboard: [
    {
      id: 'databases',
      title: 'Databases',
      tool: 'database_health',
      forEach: { setting: 'databases', arg: 'database' },
      view: { kind: 'database' },
    },
  ],
  runtime: { type: 'builtin', module: 'databases' },
  permissionsSummary: {
    'read-only': [
      'Connects to each database you list and reads its status: reachable, version, uptime, connections, read-only, and replica lag. It runs only these fixed checks: no other query, and never a change.',
      'An SSH tunnel only forwards the database port; it never runs commands on the bastion.',
    ],
  },
});
