/**
 * flowctl exchanges `FLOW_AUTH_TOKEN` (a refresh token or service-account API key) for an access token by posting it
 * in a request BODY; the OneCLI gateway injects headers only, so the key is a scoped host credential instead.
 */

import { declaredTools } from './workgroup-access.js';

/** Hosts flowctl reaches. Its HTTP client trusts only bundled roots, so OneCLI's re-signed TLS would fail it. */
export const FLOWCTL_NO_PROXY_HOSTS = ['estuary.dev', 'estuary-data.com', 'eyrcnmuzzyriypdajwdk.supabase.co'];

/**
 * An explicit `flowctl` entry in the workgroup's list or the member's own. A member with no list is unrestricted
 * everywhere else, but a write-capable Estuary key never rides on an absent list, only on a declaration.
 */
export function flowctlDeclared(workgroupTools: readonly string[], groupTools: readonly string[] | undefined): boolean {
  return declaredTools(workgroupTools, groupTools).includes('flowctl');
}

/**
 * Keyed by workgroup (`workgroup_id`, else the group's own folder), never by `credentialFolder`: an Estuary account
 * belongs to one tenant, and only that workgroup's members may reach its key.
 */
export function flowctlTokenEnvName(workgroupKey: string): string {
  return `FLOW_AUTH_TOKEN_${workgroupKey.toUpperCase().replace(/-/g, '_')}`;
}

/** The key to forward as `FLOW_AUTH_TOKEN`, or undefined when the group is not entitled to one. */
export function resolveFlowctlToken(
  workgroupTools: readonly string[],
  groupTools: readonly string[] | undefined,
  workgroupKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!flowctlDeclared(workgroupTools, groupTools)) return undefined;
  return env[flowctlTokenEnvName(workgroupKey)] || undefined;
}
