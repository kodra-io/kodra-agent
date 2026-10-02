import { SCHEMA_API_VERSION } from '@kodra-agent/schema';

/** Placeholder until M1 adds the real manifest type. */
export interface ConnectorRegistry {
  apiVersion: string;
  connectors: readonly string[];
}

export const registry: ConnectorRegistry = {
  apiVersion: SCHEMA_API_VERSION,
  connectors: [],
};
