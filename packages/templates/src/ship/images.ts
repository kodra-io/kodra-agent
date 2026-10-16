/**
 * Base images for generated Dockerfiles and CI, pinned to exact tags (checked on Docker Hub
 * on 2026-10-04). Distroless has no version tags, so it is pinned by digest.
 */
export const IMAGES = {
  maven: { 17: 'maven:3.9.16-eclipse-temurin-17', 21: 'maven:3.9.16-eclipse-temurin-21' },
  gradle: { 17: 'gradle:9.8.0-jdk17-noble', 21: 'gradle:9.8.0-jdk21-noble' },
  jre: {
    17: 'eclipse-temurin:17.0.20.1_1-jre-alpine-3.24',
    21: 'eclipse-temurin:21.0.12.1_1-jre-alpine-3.24',
  },
  node: 'node:24.21.0-alpine3.24',
  python: 'python:3.13.16-slim',
  golang: 'golang:1.25.14-alpine3.24',
  distroless:
    'gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab',
  dockerCli: 'docker:29.8.2-cli',
  dockerDind: 'docker:29.8.2-dind',
  helm: 'alpine/helm:4.3.0',
} as const;

/** Helm for generated GitHub Actions workflows, checksum-verified like the agent's own CI. */
export const HELM = {
  version: 'v4.3.0',
  linuxAmd64Sha256: '86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb',
} as const;

/** actions/checkout pinned by commit SHA. */
export const CHECKOUT_ACTION = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

export type JavaVersion = 17 | 21;
export const JAVA_VERSIONS: readonly JavaVersion[] = [17, 21];

/**
 * An image reference pulled through a mirror (PLAN-v0.2 M12), keeping its tag and digest.
 * Images without a registry are Docker Hub's: `node:24` is `docker.io/library/node:24`.
 */
export function mirrorImage(image: string, mirrors: Readonly<Record<string, string>>): string {
  const first = image.split('/')[0] ?? '';
  const hasRegistry =
    image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = hasRegistry ? first : 'docker.io';
  let path = hasRegistry ? image.slice(first.length + 1) : image;
  if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  const mirror = mirrors[registry];
  return mirror ? `${mirror.replace(/\/+$/, '')}/${path}` : image;
}

/** Every pinned base image, so generated files can be rewritten for mirrors. */
export function pinnedImages(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(IMAGES);
  // Longest first, so a tag never replaces part of a longer one.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}
