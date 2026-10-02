import {
  defineManifest,
  type Category,
  type LocalizedText,
  type Manifest,
} from '@kodra-agent/schema';
import { COMING_SOON_SUMMARY, t } from './shared.ts';

/** Coming-soon connectors are listed in the configurator but cannot be enabled. */
function comingSoon(
  id: string,
  displayName: string,
  category: Category,
  description: LocalizedText,
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
  t('Read Azure resources, AKS, and Azure Monitor.', 'قراءة موارد Azure وAKS وAzure Monitor.'),
);

export const gcp = comingSoon(
  'gcp',
  'Google Cloud',
  'cloud',
  t(
    'Read Google Cloud resources, GKE, and Cloud Monitoring.',
    'قراءة موارد Google Cloud وGKE وCloud Monitoring.',
  ),
);

export const teams = comingSoon(
  'teams',
  'Microsoft Teams',
  'chat',
  t(
    'Talk to the agent and approve its actions in Teams.',
    'تحدث مع الوكيل ووافق على إجراءاته في Teams.',
  ),
);

export const jenkins = comingSoon(
  'jenkins',
  'Jenkins',
  'cicd',
  t('Read Jenkins jobs and build logs.', 'قراءة مهام Jenkins وسجلات البناء.'),
);

export const azureDevops = comingSoon(
  'azure-devops',
  'Azure DevOps',
  'cicd',
  t('Read Azure Pipelines runs and logs.', 'قراءة تشغيلات Azure Pipelines وسجلاتها.'),
);

export const bitbucket = comingSoon(
  'bitbucket',
  'Bitbucket',
  'cicd',
  t('Read Bitbucket Pipelines runs and logs.', 'قراءة تشغيلات Bitbucket Pipelines وسجلاتها.'),
);
