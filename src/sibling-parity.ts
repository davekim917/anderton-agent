import { isDeepStrictEqual } from 'node:util';

import type { McpServerConfig } from './container-config.js';
import { excludedFleetMcpServers } from './fleet-mcp-servers.js';
import { mergeWorkgroupAndGroupSecrets } from './onecli-secrets.js';
import { effectiveExcludePlugins } from './plugin-exclusions.js';
import { effectiveTools, emptyWorkgroupAccess, type WorkgroupAccess } from './workgroup-access.js';

/**
 * Which container.json fields may differ between a source group and its `/clone-as-*` sibling. `ncl groups
 * parity-check` and the `/clone-as-*` skills MUST agree on it. Removing a field makes the next parity-check flag
 * siblings created under the old rule.
 */

/** Everything NOT here must match structurally, apart from the semantic comparisons in `findSiblingParityDrifts`. */
export const SIBLING_BOUND_FIELDS: ReadonlySet<string> = new Set([
  // Identity-bound (always per-group)
  'groupName',
  'assistantName',
  'agentGroupId',
  'credentialFolder',
  // Attribution is an explicit per-agent opt-in; a sibling must never inherit it.
  'gitIdentity',
  // Provider-bound (the reason siblings exist)
  'provider',
  'codexAuthFallbacks',
  // Its target is another provider than the group's own, so a sibling on that provider names a different one.
  'providerFallback',
  // Retired key, still ignored: parity-check reads the RAW container.json, where existing files disagree on it.
  // Remove once no `groups/*/container.json` carries it.
  'codexHostAuth',
  // Operator-tunable runtime
  'model',
  'effort',
  'imageTag',
  'defaultModel',
  'defaultEffort',
  'maxMessagesPerPrompt',
  'resources',
  // Memory + summary (per-sibling state; one writer per workgroup)
  'memory',
  'dailySummary',
]);

export function isSiblingBoundField(field: string): boolean {
  return SIBLING_BOUND_FIELDS.has(field);
}

export interface SiblingParityDrift {
  field: string;
  source: unknown;
  sibling: unknown;
}

function comparableSlackUserToken(value: unknown): unknown {
  if (value === null || value === undefined) return { enabled: false };
  if (typeof value !== 'object' || Array.isArray(value)) return value;

  const comparable = { ...(value as Record<string, unknown>) };
  delete comparable.also_allowed_in;
  comparable.enabled ??= false;
  return comparable;
}

function slackUserTokenEnabled(value: unknown): unknown {
  const comparable = comparableSlackUserToken(value);
  if (typeof comparable !== 'object' || comparable === null || Array.isArray(comparable)) return comparable;
  return (comparable as Record<string, unknown>).enabled;
}

const ACCESS_FIELDS = ['onecliSecrets', 'tools', 'mcpServers', 'excludeMcpServers', 'excludePlugins'] as const;
type AccessField = (typeof ACCESS_FIELDS)[number];

function isAccessField(field: string): field is AccessField {
  return (ACCESS_FIELDS as readonly string[]).includes(field);
}

/** What a group with this raw value is granted (or withheld) once its workgroup's are added, by the spawn's own resolvers. */
function effectiveAccessField(field: AccessField, raw: unknown, workgroup: WorkgroupAccess): unknown {
  const list = Array.isArray(raw) ? (raw as string[]) : undefined;
  if (field === 'onecliSecrets') return [...mergeWorkgroupAndGroupSecrets(workgroup.onecliSecrets, list)].sort();
  if (field === 'tools') return effectiveTools(workgroup.tools, list)?.slice().sort() ?? null;
  if (field === 'excludeMcpServers') return [...excludedFleetMcpServers({ excludeMcpServers: list }, workgroup)].sort();
  if (field === 'excludePlugins') return effectiveExcludePlugins(workgroup.excludePlugins, list).sort();
  return { ...workgroup.mcpServers, ...((raw as Record<string, McpServerConfig> | undefined) ?? {}) };
}

/**
 * Diff on capability parity, not raw serialization: Slack's non-identity settings must match (the retired `enabled`
 * flag included), while `also_allowed_in` holds exact messaging-group ids and is identity-bound. Secrets, tools,
 * MCP servers and opt-outs compare as applied — each group's workgroup's plus its own — so a declaration only one
 * sibling repeats from the shared workgroup is not drift.
 */
export function findSiblingParityDrifts(
  source: Record<string, unknown>,
  sibling: Record<string, unknown>,
  workgroups: { source: WorkgroupAccess; sibling: WorkgroupAccess } = {
    source: emptyWorkgroupAccess(),
    sibling: emptyWorkgroupAccess(),
  },
): SiblingParityDrift[] {
  const allKeys = new Set([...Object.keys(source), ...Object.keys(sibling), ...ACCESS_FIELDS]);
  const drifts: SiblingParityDrift[] = [];

  for (const field of allKeys) {
    if (isAccessField(field)) {
      const sourceValue = effectiveAccessField(field, source[field], workgroups.source);
      const siblingValue = effectiveAccessField(field, sibling[field], workgroups.sibling);
      if (!isDeepStrictEqual(sourceValue, siblingValue))
        drifts.push({ field, source: sourceValue, sibling: siblingValue });
      continue;
    }

    if (field === 'slack_user_token') {
      const sourceSlack = comparableSlackUserToken(source[field]);
      const siblingSlack = comparableSlackUserToken(sibling[field]);
      if (!isDeepStrictEqual(sourceSlack, siblingSlack)) {
        const sourceEnabled = slackUserTokenEnabled(source[field]);
        const siblingEnabled = slackUserTokenEnabled(sibling[field]);
        if (!isDeepStrictEqual(sourceEnabled, siblingEnabled)) {
          drifts.push({ field: 'slack_user_token.enabled', source: sourceEnabled, sibling: siblingEnabled });
        } else {
          drifts.push({ field, source: sourceSlack, sibling: siblingSlack });
        }
      }
      continue;
    }

    if (SIBLING_BOUND_FIELDS.has(field)) continue;
    const sourceValue = source[field] ?? null;
    const siblingValue = sibling[field] ?? null;
    if (!isDeepStrictEqual(sourceValue, siblingValue)) {
      drifts.push({ field, source: source[field], sibling: sibling[field] });
    }
  }

  return drifts;
}
