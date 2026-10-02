import { defineManifest } from '@kodra-agent/schema';
import { PATTERNS, t } from './shared.ts';

/**
 * Model providers. They are selected with spec.model.provider, not spec.connectors, and
 * their configFields and secrets map one to one onto the keys of spec.model.
 */

const redactNote = t(
  'Secrets are removed from everything sent to the model.',
  'تُحذف الأسرار من كل ما يُرسل إلى النموذج.',
);

export const anthropic = defineManifest({
  id: 'anthropic',
  displayName: 'Anthropic',
  category: 'model',
  status: 'available',
  description: t(
    'Claude models through the Anthropic API.',
    'نماذج Claude عبر واجهة Anthropic البرمجية.',
  ),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: false,
      description: t(
        'Only for a proxy or gateway in front of the Anthropic API.',
        'فقط عند استخدام خادم وسيط أو بوابة أمام واجهة Anthropic.',
      ),
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'ANTHROPIC_API_KEY',
      defaultRef: 'env',
      required: true,
      description: t('Anthropic API key.', 'مفتاح واجهة Anthropic البرمجية.'),
      howToCreate: t(
        'Create an API key in the Anthropic Console.',
        'أنشئ مفتاحا في Anthropic Console.',
      ),
      minimumScopes: {},
      probe: 'anthropic.list-models',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Sends prompts and tool results to Anthropic with your key.',
        'يرسل الطلبات ونتائج الأدوات إلى Anthropic بمفتاحك.',
      ),
      redactNote,
    ],
  },
});

export const openai = defineManifest({
  id: 'openai',
  displayName: 'OpenAI',
  category: 'model',
  status: 'available',
  description: t('Models through the OpenAI API.', 'النماذج عبر واجهة OpenAI البرمجية.'),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: false,
      description: t(
        'Only for a proxy, a gateway, or an OpenAI-compatible server.',
        'فقط عند استخدام خادم وسيط أو بوابة أو خادم متوافق مع OpenAI.',
      ),
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'OPENAI_API_KEY',
      defaultRef: 'env',
      required: true,
      description: t('OpenAI API key.', 'مفتاح واجهة OpenAI البرمجية.'),
      howToCreate: t(
        'Create an API key in the OpenAI platform dashboard.',
        'أنشئ مفتاحا في لوحة تحكم منصة OpenAI.',
      ),
      minimumScopes: {},
      probe: 'openai.list-models',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Sends prompts and tool results to OpenAI with your key.',
        'يرسل الطلبات ونتائج الأدوات إلى OpenAI بمفتاحك.',
      ),
      redactNote,
    ],
  },
});

export const azureOpenai = defineManifest({
  id: 'azure-openai',
  displayName: 'Azure OpenAI',
  category: 'model',
  status: 'available',
  description: t(
    'Models deployed in your Azure OpenAI resource.',
    'النماذج المنشورة في مورد Azure OpenAI الخاص بك.',
  ),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'endpoint',
      required: true,
      description: t('Azure OpenAI resource endpoint.', 'عنوان مورد Azure OpenAI.'),
      example: 'https://my-resource.openai.azure.com',
    },
    {
      kind: 'string',
      key: 'deployment',
      required: true,
      description: t('Deployment name in that resource.', 'اسم النشر في ذلك المورد.'),
    },
  ],
  secrets: [
    {
      key: 'apiKey',
      envVar: 'AZURE_OPENAI_API_KEY',
      defaultRef: 'env',
      required: true,
      description: t('Azure OpenAI API key.', 'مفتاح Azure OpenAI.'),
      howToCreate: t(
        'Copy a key from your Azure OpenAI resource, under Keys and Endpoint.',
        'انسخ مفتاحا من مورد Azure OpenAI، من قسم Keys and Endpoint.',
      ),
      minimumScopes: {},
      probe: 'azure-openai.list-models',
    },
  ],
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Sends prompts and tool results to your Azure OpenAI resource.',
        'يرسل الطلبات ونتائج الأدوات إلى مورد Azure OpenAI الخاص بك.',
      ),
      redactNote,
    ],
  },
});

export const bedrock = defineManifest({
  id: 'bedrock',
  displayName: 'AWS Bedrock',
  category: 'model',
  status: 'available',
  description: t(
    'Models through Amazon Bedrock in your AWS account.',
    'النماذج عبر Amazon Bedrock في حساب AWS الخاص بك.',
  ),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'string',
      key: 'region',
      required: true,
      description: t('AWS region where Bedrock runs.', 'منطقة AWS التي يعمل فيها Bedrock.'),
      pattern: PATTERNS.awsRegion,
      patternHint: t('use an AWS region, like eu-central-1', 'استخدم منطقة AWS، مثل eu-central-1'),
      example: 'eu-central-1',
    },
  ],
  secrets: [],
  healthProbe: 'bedrock.get-caller-identity',
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Sends prompts and tool results to Amazon Bedrock in your account. Uses the standard AWS credentials, such as an IAM role.',
        'يرسل الطلبات ونتائج الأدوات إلى Amazon Bedrock في حسابك. يستخدم بيانات اعتماد AWS المعتادة، مثل دور IAM.',
      ),
      redactNote,
    ],
  },
});

export const ollama = defineManifest({
  id: 'ollama',
  displayName: 'Ollama',
  category: 'model',
  status: 'available',
  description: t(
    'Models on your own Ollama server. Works without internet access.',
    'النماذج على خادم Ollama الخاص بك. يعمل دون اتصال بالإنترنت.',
  ),
  accessLevels: [],
  requires: [],
  configFields: [
    {
      kind: 'url',
      key: 'baseUrl',
      required: true,
      description: t('Ollama server address.', 'عنوان خادم Ollama.'),
      example: 'http://ollama:11434',
    },
  ],
  secrets: [],
  healthProbe: 'ollama.list-models',
  tools: {},
  runtime: null,
  permissionsSummary: {
    always: [
      t(
        'Sends prompts to your own Ollama server. Nothing leaves your network.',
        'يرسل الطلبات إلى خادم Ollama الخاص بك. لا شيء يغادر شبكتك.',
      ),
    ],
  },
});
