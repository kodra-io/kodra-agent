import { defineManifest } from '@kodra-agent/schema';
import { t } from '../shared.ts';

/** A host name or an IP address (v4, or v6 in brackets or plain). */
const HOST =
  '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\\[?[0-9A-Fa-f:.]+\\]?)$';

export default defineManifest({
  id: 'databases',
  displayName: 'Databases',
  category: 'database',
  status: 'available',
  description: t(
    'Watch the databases you list, wherever they run: standalone, in the cloud (like Amazon RDS), or in Kubernetes. MariaDB, MySQL, and PostgreSQL, directly or through an SSH tunnel. Health checks only.',
    'راقب قواعد البيانات التي تضيفها أينما كانت: مستقلة، أو في السحابة (مثل Amazon RDS)، أو في Kubernetes. MariaDB وMySQL وPostgreSQL، مباشرة أو عبر نفق SSH. فحوص الحالة فقط.',
  ),
  accessLevels: ['read-only'],
  requires: [],
  configFields: [
    {
      kind: 'entries',
      key: 'databases',
      required: false,
      description: t(
        'The databases to watch. Use a database user that can only read.',
        'قواعد البيانات المراد مراقبتها. استخدم مستخدما لقاعدة البيانات يملك القراءة فقط.',
      ),
      noun: t('database', 'قاعدة بيانات'),
      envPrefix: 'KODRA_DB_',
      max: 20,
      fields: [
        {
          kind: 'choice',
          key: 'engine',
          required: true,
          description: t('Database engine.', 'محرك قاعدة البيانات.'),
          options: ['mariadb', 'mysql', 'postgres'],
        },
        {
          kind: 'string',
          key: 'host',
          required: true,
          description: t(
            'Host name or IP address, as seen from the agent (or from the tunnel host).',
            'اسم المضيف أو عنوان IP، كما يراه الوكيل (أو مضيف النفق).',
          ),
          pattern: HOST,
          patternHint: t('use a host name or an IP address', 'استخدم اسم مضيف أو عنوان IP'),
          example: 'orders.abc123.eu-central-1.rds.amazonaws.com',
        },
        {
          kind: 'integer',
          key: 'port',
          required: false,
          description: t(
            'Port. Leave empty for the engine default (3306 or 5432).',
            'المنفذ. اتركه فارغا لاستخدام المنفذ الافتراضي للمحرك (3306 أو 5432).',
          ),
          min: 1,
          max: 65535,
        },
        {
          kind: 'string',
          key: 'database',
          required: false,
          description: t(
            'Database to connect to. PostgreSQL uses postgres when empty.',
            'قاعدة البيانات التي يتم الاتصال بها. يستخدم PostgreSQL قاعدة postgres إذا تُرك فارغا.',
          ),
          pattern: '^[A-Za-z0-9_$-]{1,63}$',
          patternHint: t('use letters, digits, _, $, and -', 'استخدم الحروف والأرقام و _ و $ و -'),
        },
        {
          kind: 'string',
          key: 'user',
          required: true,
          description: t('Database user.', 'مستخدم قاعدة البيانات.'),
          pattern: '^[A-Za-z0-9_.@-]{1,63}$',
          patternHint: t('use letters, digits, and _ . @ -', 'استخدم الحروف والأرقام و _ . @ -'),
          example: 'kodra_monitor',
        },
        {
          kind: 'secret',
          key: 'password',
          required: false,
          description: t('The database user’s password.', 'كلمة مرور مستخدم قاعدة البيانات.'),
          howToCreate: t(
            'Create a user that can only read server status (see docs/connectors/databases.md for the grant per engine), then enter its password here. It is tested before it is saved.',
            'أنشئ مستخدما يقرأ حالة الخادم فقط (راجع docs/connectors/databases.md لمعرفة الصلاحية لكل محرك)، ثم أدخل كلمة مروره هنا. يتم اختبارها قبل حفظها.',
          ),
          envVar: 'PASSWORD',
        },
        {
          kind: 'choice',
          key: 'tls',
          required: false,
          description: t(
            'Encryption: verify (encrypted, certificate checked), require (encrypted, certificate not checked), or off.',
            'التشفير: verify (مشفر مع فحص الشهادة)، أو require (مشفر دون فحص الشهادة)، أو off.',
          ),
          options: ['verify', 'require', 'off'],
          default: 'verify',
        },
        {
          kind: 'string',
          key: 'tunnelHost',
          required: false,
          description: t(
            'SSH tunnel: the bastion host to connect through. Leave empty to connect directly.',
            'نفق SSH: مضيف العبور الذي يتم الاتصال من خلاله. اتركه فارغا للاتصال المباشر.',
          ),
          pattern: HOST,
          patternHint: t('use a host name or an IP address', 'استخدم اسم مضيف أو عنوان IP'),
          example: 'bastion.example.com',
        },
        {
          kind: 'integer',
          key: 'tunnelPort',
          required: false,
          description: t('SSH tunnel: the bastion’s SSH port.', 'نفق SSH: منفذ SSH لمضيف العبور.'),
          min: 1,
          max: 65535,
          default: 22,
        },
        {
          kind: 'string',
          key: 'tunnelUser',
          required: false,
          requiredWith: 'tunnelHost',
          description: t(
            'SSH tunnel: the user on the bastion.',
            'نفق SSH: المستخدم على مضيف العبور.',
          ),
          pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$',
          patternHint: t('use a Linux user name', 'استخدم اسم مستخدم Linux'),
        },
        {
          kind: 'string',
          key: 'tunnelHostKey',
          required: false,
          requiredWith: 'tunnelHost',
          description: t(
            'SSH tunnel: the bastion’s host key fingerprint. The tunnel is refused if it does not match. Get it with: ssh-keyscan bastion | ssh-keygen -lf -',
            'نفق SSH: بصمة مفتاح مضيف العبور. يُرفض النفق إذا لم تتطابق. احصل عليها بالأمر: ssh-keyscan bastion | ssh-keygen -lf -',
          ),
          pattern: '^SHA256:[A-Za-z0-9+/]{43}=?$',
          patternHint: t(
            'use a SHA256 fingerprint, like SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
            'استخدم بصمة SHA256، مثل SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8',
          ),
        },
        {
          kind: 'secret',
          key: 'tunnelKey',
          required: false,
          requiredWith: 'tunnelHost',
          description: t(
            'SSH tunnel: the private key for the bastion user.',
            'نفق SSH: المفتاح الخاص لمستخدم مضيف العبور.',
          ),
          howToCreate: t(
            'Make a key just for this (ssh-keygen -t ed25519), and limit it on the bastion to port forwarding to this database: in authorized_keys, restrict,port-forwarding,permitopen="db-host:port". Paste the private key here.',
            'أنشئ مفتاحا لهذا الغرض فقط (ssh-keygen -t ed25519)، وقيّده على مضيف العبور بتمرير المنفذ إلى قاعدة البيانات هذه فقط: في authorized_keys استخدم restrict,port-forwarding,permitopen="db-host:port". الصق المفتاح الخاص هنا.',
          ),
          envVar: 'TUNNEL_KEY',
        },
        {
          kind: 'integer',
          key: 'maxLagSeconds',
          required: false,
          description: t(
            'A replica this many seconds behind is not fully healthy.',
            'تُعد النسخة المتماثلة غير سليمة تماما إذا تأخرت هذا العدد من الثواني.',
          ),
          min: 1,
          max: 86400,
          default: 30,
        },
        {
          kind: 'integer',
          key: 'connectionsWarnPercent',
          required: false,
          description: t(
            'Connections in use, as a percentage of the maximum, at which the database is not fully healthy.',
            'نسبة الاتصالات المستخدمة من الحد الأقصى التي تُعد عندها قاعدة البيانات غير سليمة تماما.',
          ),
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
      title: t('Databases', 'قواعد البيانات'),
      tool: 'database_health',
      forEach: { setting: 'databases', arg: 'database' },
      view: { kind: 'database' },
    },
  ],
  runtime: { type: 'builtin', module: 'databases' },
  permissionsSummary: {
    'read-only': [
      t(
        'Connects to each database you list and reads its status: reachable, version, uptime, connections, read-only, and replica lag. It runs only these fixed checks: no other query, and never a change.',
        'يتصل بكل قاعدة بيانات تضيفها ويقرأ حالتها: إمكانية الوصول، والإصدار، ومدة التشغيل، والاتصالات، ووضع القراءة فقط، وتأخر النسخة المتماثلة. لا ينفذ إلا هذه الفحوص الثابتة: لا استعلامات أخرى، ولا أي تغيير.',
      ),
      t(
        'An SSH tunnel only forwards the database port; it never runs commands on the bastion.',
        'نفق SSH يمرر منفذ قاعدة البيانات فقط، ولا ينفذ أي أوامر على مضيف العبور.',
      ),
    ],
  },
});
