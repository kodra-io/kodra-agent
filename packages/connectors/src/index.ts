import {
  buildAgentConfigSchema,
  checkDependencies,
  parseAgentConfig as parseWith,
  type DependencyIssue,
  type Manifest,
  type ParseResult,
} from '@kodra-agent/schema';
import aws from './aws/manifest.ts';
import { azure, azureDevops, bitbucket, gcp, jenkins, teams } from './coming-soon.ts';
import docker from './docker/manifest.ts';
import githubActions from './github-actions/manifest.ts';
import github from './github/manifest.ts';
import gitlabCi from './gitlab-ci/manifest.ts';
import gitlab from './gitlab/manifest.ts';
import grafana from './grafana/manifest.ts';
import kubernetes from './kubernetes/manifest.ts';
import { anthropic, azureOpenai, bedrock, ollama, openai } from './models.ts';
import prometheus from './prometheus/manifest.ts';
import slack from './slack/manifest.ts';

/** Every connector, in the order the configurator shows them. */
export const connectors: readonly Manifest[] = [
  github,
  gitlab,
  docker,
  kubernetes,
  githubActions,
  gitlabCi,
  jenkins,
  azureDevops,
  bitbucket,
  prometheus,
  grafana,
  aws,
  azure,
  gcp,
  slack,
  teams,
];

/** Model providers, selected with spec.model.provider. */
export const modelProviders: readonly Manifest[] = [
  anthropic,
  openai,
  azureOpenai,
  bedrock,
  ollama,
];

export function getConnector(id: string): Manifest | undefined {
  return connectors.find((c) => c.id === id);
}

export function getModelProvider(id: string): Manifest | undefined {
  return modelProviders.find((p) => p.id === id);
}

/** The kodra-agent.yaml schema for this release's connectors. */
export const agentConfigSchema = buildAgentConfigSchema(connectors);

/** Parses and validates kodra-agent.yaml text against this release's connectors. */
export function parseAgentConfig(text: string): ParseResult {
  return parseWith(text, agentConfigSchema);
}

/** Unmet `requires` rules for a set of enabled connector ids. */
export function dependencyIssues(enabledIds: readonly string[]): DependencyIssue[] {
  return checkDependencies(connectors, enabledIds);
}
