import type { LocalizedText, Manifest, Requirement } from './manifest.ts';

export interface DependencyIssue {
  /** The enabled connector whose requirement is not met. */
  connector: string;
  requirement: Requirement;
  message: LocalizedText;
}

/**
 * Checks each enabled connector's `requires` rules against the set of enabled connectors.
 * A rule is met when any of its alternatives is enabled (by connector id or by category).
 */
export function checkDependencies(
  manifests: readonly Manifest[],
  enabledIds: readonly string[],
): DependencyIssue[] {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const enabled = enabledIds.flatMap((id) => {
    const manifest = byId.get(id);
    return manifest ? [manifest] : [];
  });

  const issues: DependencyIssue[] = [];
  for (const manifest of enabled) {
    for (const requirement of manifest.requires) {
      const met = requirement.anyOf.some((alt) =>
        'connector' in alt
          ? enabled.some((m) => m.id === alt.connector)
          : enabled.some((m) => m.category === alt.category && m.id !== manifest.id),
      );
      if (!met) {
        issues.push({ connector: manifest.id, requirement, message: requirement.message });
      }
    }
  }
  return issues;
}
