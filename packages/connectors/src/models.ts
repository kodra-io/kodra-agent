import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS } from './shared.ts';

/**
 * Model providers. They are selected with spec.model.provider, not spec.connectors, and
 * their configFields and secrets map one to one onto the keys of spec.model.
 */

const redactNote = 'Secrets are removed from everything sent to the model.';

export const anthropic = defineManifest({
  id: 'anthropic',
  displayName: 'Anthropic',
  category: 'model',
  status: 'available',
  description: 'Claude models through the Anthropic API.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: false,
      description: 'Only for a proxy or gateway in front of the Anthropic API.',
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'ANTHROPIC_API_KEY',
      defaultRef: 'env',
      required: true,
      description: 'Anthropic API key.',
      howToCreate: 'Create an API key in the Anthropic Console.',
      minimumScopes: {},
      probe: 'anthropic.list-models',
      steps: [
        {
          text: 'Create a key in the Claude Console, copy it, and paste it here. It is tested before it is saved.',
          link: 'https://console.anthropic.com/settings/keys',
        },
      ],
    },
  ],
  tools: {},
  runtime: null,
  // List prices, US dollars per million tokens (cache writes are 1.25x input for the
  // 5-minute cache). Only used for the console's estimated cost; override in the config.
  pricing: {
    asOf: '2026-09-25',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    models: {
      'claude-fable-5-1': {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 0.25,
        cacheWritePerMTok: 12.5,
      },
      'claude-opus-5-5': {
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 5,
      },
      'claude-opus-5': {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
      'claude-opus-4-8': {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
      'claude-sonnet-5-5': {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 2.5,
      },
      'claude-sonnet-5': {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.2,
        cacheWritePerMTok: 2.5,
      },
      'claude-haiku-4-5': {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
      },
    },
  },
  permissionsSummary: {
    always: ['Sends prompts and tool results to Anthropic with your key.', redactNote],
  },
});

export const openai = defineManifest({
  id: 'openai',
  displayName: 'OpenAI',
  category: 'model',
  status: 'available',
  description: 'Models through the OpenAI API.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: false,
      description: 'Only for a proxy, a gateway, or an OpenAI-compatible server.',
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'OPENAI_API_KEY',
      defaultRef: 'env',
      required: true,
      description: 'OpenAI API key.',
      howToCreate: 'Create an API key in the OpenAI platform dashboard.',
      minimumScopes: {},
      probe: 'openai.list-models',
      steps: [
        {
          text: 'Create a key in the OpenAI platform, copy it, and paste it here. It is tested before it is saved.',
          link: 'https://platform.openai.com/api-keys',
        },
      ],
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: ['Sends prompts and tool results to OpenAI with your key.', redactNote],
  },
});

/** Parked (B4): not in modelProviders while cloud providers are off. */
export const azureOpenai = defineManifest({
  id: 'azure-openai',
  displayName: 'Azure OpenAI',
  category: 'model',
  status: 'available',
  description: 'Models deployed in your Azure OpenAI resource.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'endpoint',
      required: true,
      description: 'Azure OpenAI resource endpoint.',
      example: 'https://my-resource.openai.azure.com',
    },
    {
      kind: 'string',
      key: 'deployment',
      required: true,
      description: 'Deployment name in that resource.',
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'AZURE_OPENAI_API_KEY',
      defaultRef: 'env',
      required: true,
      description: 'Azure OpenAI API key.',
      howToCreate: 'Copy a key from your Azure OpenAI resource, under Keys and Endpoint.',
      minimumScopes: {},
      probe: 'azure-openai.list-models',
      steps: [
        {
          text: 'In the Azure portal, open your Azure OpenAI resource, then Keys and Endpoint, and copy Key 1. Or, with the Azure CLI:',
          run: {
            all: 'az cognitiveservices account keys list --name <resource-name> --resource-group <resource-group> --query key1 --output tsv',
          },
        },
        { text: 'Paste the key here. It is tested before it is saved.' },
      ],
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: ['Sends prompts and tool results to your Azure OpenAI resource.', redactNote],
  },
});

/** Parked (B4): not in modelProviders while cloud providers are off. */
export const bedrock = defineManifest({
  id: 'bedrock',
  displayName: 'AWS Bedrock',
  category: 'model',
  status: 'available',
  description: 'Models through Amazon Bedrock in your AWS account.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'region',
      required: true,
      description: 'AWS region where Bedrock runs.',
      pattern: PATTERNS.awsRegion,
      patternHint: 'use an AWS region, like eu-central-1',
      example: 'eu-central-1',
    },
  ],
  secrets: [],
  healthProbe: 'bedrock.get-caller-identity',
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      'Sends prompts and tool results to Amazon Bedrock in your account. Uses the standard AWS credentials, such as an IAM role.',
      redactNote,
    ],
  },
});

export const ollama = defineManifest({
  id: 'ollama',
  displayName: 'Ollama',
  category: 'model',
  status: 'available',
  description: 'Models on your own Ollama server. Works without internet access.',
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: true,
      description:
        'Ollama server address. Ollama on the same machine as Docker: http://host.docker.internal:11434. A service named ollama in the same Compose file: http://ollama:11434. Ollama in Kubernetes: http://ollama.<namespace>.svc:11434.',
      example: 'http://host.docker.internal:11434',
    },
  ],
  secrets: [],
  healthProbe: 'ollama.list-models',
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: ['Sends prompts to your own Ollama server. Nothing leaves your network.'],
  },
});
