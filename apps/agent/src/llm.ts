import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ModelConfig } from '@kodra-agent/schema';
import type { LanguageModel } from 'ai';

/** Base URLs in kodra-agent.yaml are API roots without a version, like the probes use. */
const v1 = (base: string) => `${base.replace(/\/+$/, '')}/v1`;

/**
 * One model interface over every provider (Vercel AI SDK). Secret values come in already
 * resolved and registered with the redactor; this module never reads the environment.
 */
export function createModel(
  model: ModelConfig,
  secrets: Readonly<Record<string, string>>,
): LanguageModel {
  switch (model.provider) {
    case 'anthropic':
      return createAnthropic({
        apiKey: required(secrets, 'apiKey'),
        ...(model.baseUrl ? { baseURL: v1(model.baseUrl) } : {}),
      })(model.name);
    case 'openai':
      return createOpenAI({
        apiKey: required(secrets, 'apiKey'),
        ...(model.baseUrl ? { baseURL: v1(model.baseUrl) } : {}),
      })(model.name);
    case 'azure-openai':
      // The v1 API: {endpoint}/openai/v1/…, with the deployment name as the model.
      return createAzure({
        apiKey: required(secrets, 'apiKey'),
        baseURL: `${model.endpoint.replace(/\/+$/, '')}/openai`,
      })(model.deployment);
    case 'bedrock':
      // Standard AWS credentials: environment, IRSA, or a profile (SPEC section 5).
      return createAmazonBedrock({
        region: model.region,
        credentialProvider: fromNodeProviderChain(),
      })(model.name);
    case 'ollama':
      // Ollama's OpenAI-compatible endpoint, so no community provider package is needed.
      return createOpenAICompatible({ name: 'ollama', baseURL: v1(model.baseUrl) })(model.name);
  }
}

function required(secrets: Readonly<Record<string, string>>, key: string): string {
  const value = secrets[key];
  if (!value) throw new Error(`the model ${key} is not set; run kodra-agent init`);
  return value;
}
