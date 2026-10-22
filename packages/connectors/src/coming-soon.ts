import { defineManifest, type Category, type Manifest } from '@kodra-agent/schema';
import { COMING_SOON_SUMMARY } from './shared.ts';

/** Coming-soon connectors are listed in the configurator but cannot be enabled. */
function comingSoon(
  id: string,
  displayName: string,
  category: Category,
  description: string,
): Manifest {
  return defineManifest({
    id,
    displayName,
    category,
    status: 'coming-soon',
    description,
    accessLevels: [],
    requires: [],
    configFields: [],
    secrets: [],
    tools: {},
    runtime: null,
    permissionsSummary: COMING_SOON_SUMMARY,
  });
}

export const azure = comingSoon(
  'azure',
  'Microsoft Azure',
  'cloud',
  'Read Azure resources, AKS, and Azure Monitor.',
);

export const gcp = comingSoon(
  'gcp',
  'Google Cloud',
  'cloud',
  'Read Google Cloud resources, GKE, and Cloud Monitoring.',
);

export const teams = comingSoon(
  'teams',
  'Microsoft Teams',
  'chat',
  'Talk to the agent and approve its actions in Teams.',
);

export const azureDevops = comingSoon(
  'azure-devops',
  'Azure DevOps',
  'cicd',
  'Read Azure Pipelines runs and logs.',
);

export const bitbucket = comingSoon(
  'bitbucket',
  'Bitbucket',
  'cicd',
  'Read Bitbucket Pipelines runs and logs.',
);
