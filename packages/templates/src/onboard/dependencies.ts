import type { RepoFiles } from '../ship/detect.ts';

export type DependencyKind = 'database' | 'cache' | 'queue' | 'storage' | 'search' | 'email';

export interface Dependency {
  kind: DependencyKind;
  name: string;
  /** The files that showed it, for the report. */
  evidence: string[];
}

/** Build and dependency files read for library names. */
export const MANIFEST_FILE =
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod)$/;

interface Known {
  kind: DependencyKind;
  name: string;
  /** Library names, matched case-insensitively inside dependency files. */
  libraries: string[];
  /** Image names in a Compose file. */
  images: string[];
}

const KNOWN: readonly Known[] = [
  {
    kind: 'database',
    name: 'PostgreSQL',
    libraries: ['org.postgresql', '"pg"', 'psycopg', 'asyncpg', 'jackc/pgx', 'lib/pq'],
    images: ['postgres', 'postgis/postgis', 'bitnami/postgresql'],
  },
  {
    kind: 'database',
    name: 'MySQL or MariaDB',
    libraries: [
      'mysql-connector',
      'mariadb-java-client',
      '"mysql"',
      '"mysql2"',
      '"mariadb"',
      'pymysql',
      'mysqlclient',
      'go-sql-driver/mysql',
    ],
    images: ['mysql', 'mariadb', 'bitnami/mysql', 'bitnami/mariadb'],
  },
  {
    kind: 'database',
    name: 'MongoDB',
    libraries: [
      '"mongodb"',
      '"mongoose"',
      'pymongo',
      'motor',
      'mongo-driver',
      'spring-boot-starter-data-mongodb',
    ],
    images: ['mongo', 'bitnami/mongodb'],
  },
  {
    kind: 'cache',
    name: 'Redis',
    libraries: [
      '"redis"',
      '"ioredis"',
      'redis==',
      'redis>=',
      'spring-boot-starter-data-redis',
      'jedis',
      'go-redis',
      'redis/go-redis',
    ],
    images: ['redis', 'valkey/valkey', 'bitnami/redis'],
  },
  {
    kind: 'queue',
    name: 'RabbitMQ',
    libraries: ['spring-boot-starter-amqp', '"amqplib"', 'pika', 'aio-pika', 'amqp091-go'],
    images: ['rabbitmq', 'bitnami/rabbitmq'],
  },
  {
    kind: 'queue',
    name: 'Kafka',
    libraries: [
      'spring-kafka',
      'kafka-clients',
      '"kafkajs"',
      'confluent-kafka',
      'kafka-python',
      'segmentio/kafka-go',
      'IBM/sarama',
    ],
    images: ['confluentinc/cp-kafka', 'bitnami/kafka', 'apache/kafka'],
  },
  {
    kind: 'storage',
    name: 'AWS (S3 or other AWS services)',
    libraries: ['software.amazon.awssdk', '@aws-sdk/', '"aws-sdk"', 'boto3', 'aws-sdk-go'],
    images: ['minio/minio', 'localstack/localstack'],
  },
  {
    kind: 'search',
    name: 'Elasticsearch or OpenSearch',
    libraries: ['elasticsearch', 'opensearch'],
    images: ['elasticsearch', 'opensearchproject/opensearch'],
  },
  {
    kind: 'email',
    name: 'Email (SMTP or a mail API)',
    libraries: ['spring-boot-starter-mail', '"nodemailer"', '@sendgrid/', 'sendgrid'],
    images: ['mailhog/mailhog', 'axllent/mailpit'],
  },
];

const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

/** `image:` values in a Compose file, without registry, tag, or digest. */
function composeImages(text: string): string[] {
  const images: string[] = [];
  for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) {
    const ref = (m[1] ?? '').split('@')[0] ?? '';
    const withoutTag = ref.replace(/:[^/]*$/, '');
    // docker.io/library/postgres -> postgres; ghcr.io/x/y -> x/y
    const parts = withoutTag.split('/');
    if (parts.length > 1 && /[.:]/.test(parts[0] ?? '')) parts.shift();
    if (parts[0] === 'library') parts.shift();
    images.push(parts.join('/').toLowerCase());
  }
  return images;
}

/** What the app talks to, from library names and Compose services. Nothing is run. */
export function findDependencies(files: RepoFiles): Dependency[] {
  const found = new Map<string, Dependency>();
  const add = (k: Known, path: string) => {
    const d = found.get(k.name) ?? { kind: k.kind, name: k.name, evidence: [] };
    if (!d.evidence.includes(path)) d.evidence.push(path);
    found.set(k.name, d);
  };
  for (const path of files.paths) {
    if (/(^|\/)(node_modules|vendor)\//.test(path)) continue;
    if (MANIFEST_FILE.test(path)) {
      const text = (files.read(path) ?? '').toLowerCase();
      for (const k of KNOWN) {
        if (k.libraries.some((lib) => text.includes(lib.toLowerCase()))) add(k, path);
      }
    } else if (COMPOSE_FILE.test(path)) {
      const images = composeImages(files.read(path) ?? '');
      for (const k of KNOWN) {
        if (images.some((i) => k.images.includes(i))) add(k, path);
      }
    }
  }
  return KNOWN.flatMap((k) => {
    const d = found.get(k.name);
    return d ? [d] : [];
  });
}
