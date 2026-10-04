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
