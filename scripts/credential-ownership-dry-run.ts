/**
 * Prints, per workgroup, which scoped host credentials each member would gain or lose if a proposed credential
 * ownership policy replaced the installed data/credential-ownership.json (or its absence). Writes nothing.
 *
 *   pnpm exec tsx scripts/credential-ownership-dry-run.ts --policy <proposed.json> [--json]
 *
 * Run from the install root (paths resolve from the working directory). Exit: 0 printed, 1 failed, 2 invalid
 * arguments. Opens the central DB read-only and works before or after the deploy that adds `workgroups.tools`.
 *
 * Each credential is `<kind>:<scope>`; `<kind>:*` is a whole store mounted as is, including files no scope names
 * (a bare tool with no policy file). What a member is staged comes from `stagedCredentialScopes`, the function the
 * spawn stages from.
 */
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readContainerConfig } from '../src/container-config.js';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_OWNERSHIP_POLICY_PATH,
  hostCredentialScopes,
  loadCredentialOwnership,
  stagedCredentialScopes,
  type CredentialKind,
  type CredentialOwnership,
} from '../src/credential-ownership.js';
import { effectiveTools } from '../src/workgroup-access.js';

export interface DryRunMember {
  folder: string;
  workgroupId: string;
  /** Effective tools, as the spawn resolves them; undefined is unrestricted. */
  tools: string[] | undefined;
}

export type HostInventory = Record<CredentialKind, string[]>;

/** The `<kind>:<scope>` credentials the spawn stages for one member. */
function stagedCredentials(
  member: DryRunMember,
  ownership: CredentialOwnership | null,
  inventory: HostInventory,
): string[] {
  return CREDENTIAL_KINDS.flatMap((kind) => {
    const staged = stagedCredentialScopes(kind, member.tools, member.workgroupId, ownership, () => inventory[kind]);
    if (!staged) return [];
    if (!staged.isScoped) return [`${kind}:*`];
    return staged.scopes.filter((scope) => inventory[kind].includes(scope)).map((scope) => `${kind}:${scope}`);
  });
}

/** `*` expands to the store's named scopes, so narrowing a bare tool shows exactly which credentials go. */
function expand(credentials: string[], inventory: HostInventory): Set<string> {
  const out = new Set<string>();
  for (const credential of credentials) {
    const [kind, scope] = credential.split(/:(.*)/s) as [CredentialKind, string];
    if (scope === '*') for (const s of inventory[kind]) out.add(`${kind}:${s}`);
    out.add(credential);
  }
  return out;
}

export interface MemberChange {
  folder: string;
  lost: string[];
  gained: string[];
}

export function diffMember(
  member: DryRunMember,
  before: CredentialOwnership | null,
  after: CredentialOwnership | null,
  inventory: HostInventory,
): MemberChange {
  const was = expand(stagedCredentials(member, before, inventory), inventory);
  const now = expand(stagedCredentials(member, after, inventory), inventory);
  return {
    folder: member.folder,
    lost: [...was].filter((c) => !now.has(c)).sort(),
    gained: [...now].filter((c) => !was.has(c)).sort(),
  };
}

/** Host scopes no workgroup owns under the policy: staged for no workgroup. */
export function unownedScopes(ownership: CredentialOwnership, inventory: HostInventory): string[] {
  return CREDENTIAL_KINDS.flatMap((kind) =>
    inventory[kind]
      .filter((scope) => (ownership.get(kind)?.get(scope)?.size ?? 0) === 0)
      .map((scope) => `${kind}:${scope}`),
  );
}

function loadMembers(): DryRunMember[] {
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  try {
    const hasTools = (db.prepare('PRAGMA table_info(workgroups)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'tools',
    );
    const workgroupTools = new Map<string, string[]>();
    if (hasTools) {
      for (const row of db.prepare('SELECT id, tools FROM workgroups').all() as Array<{
        id: string;
        tools: string | null;
      }>) {
        workgroupTools.set(row.id, row.tools === null ? [] : (JSON.parse(row.tools) as string[]));
      }
    }
    const groups = db.prepare('SELECT folder, workgroup_id FROM agent_groups ORDER BY folder').all() as Array<{
      folder: string;
      workgroup_id: string | null;
    }>;
    return groups.flatMap((group) => {
      const config = readContainerConfig(group.folder);
      // A wiki actor's spawn stages no host credentials.
      if (config.wikiMaintenance === true) return [];
      const workgroupId = config.workgroup_id ?? group.workgroup_id ?? group.folder;
      return [
        {
          folder: group.folder,
          workgroupId,
          tools: effectiveTools(workgroupTools.get(workgroupId) ?? [], config.tools),
        },
      ];
    });
  } finally {
    db.close();
  }
}

function main(policyPath: string, json: boolean): number {
  const before = loadCredentialOwnership();
  const after = loadCredentialOwnership(path.resolve(policyPath));
  if (!after) throw new Error(`No proposed policy at ${path.resolve(policyPath)}`);
  const home = os.homedir();
  const inventory = Object.fromEntries(
    CREDENTIAL_KINDS.map((kind) => [kind, hostCredentialScopes(kind, home).sort()]),
  ) as HostInventory;
  const members = loadMembers();
  const byWorkgroup = new Map<string, MemberChange[]>();
  for (const member of members) {
    const changes = byWorkgroup.get(member.workgroupId) ?? [];
    changes.push(diffMember(member, before, after, inventory));
    byWorkgroup.set(member.workgroupId, changes);
  }
  const workgroups = [...byWorkgroup.keys()].sort();
  const unowned = unownedScopes(after, inventory);
  if (json) {
    console.log(
      JSON.stringify(
        { workgroups: Object.fromEntries(workgroups.map((wg) => [wg, byWorkgroup.get(wg)])), unowned },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`Installed: ${CREDENTIAL_OWNERSHIP_POLICY_PATH}${before ? '' : ' (absent)'}`);
  console.log(`Proposed:  ${path.resolve(policyPath)}\n`);
  for (const wg of workgroups) {
    console.log(`workgroup ${wg}`);
    for (const change of byWorkgroup.get(wg) ?? []) {
      if (change.lost.length === 0 && change.gained.length === 0) {
        console.log(`  ${change.folder}: no change`);
        continue;
      }
      if (change.lost.length > 0) console.log(`  ${change.folder}: loses ${change.lost.join(', ')}`);
      if (change.gained.length > 0) console.log(`  ${change.folder}: gains ${change.gained.join(', ')}`);
    }
  }
  console.log(`\nUnowned on this host (staged for no workgroup): ${unowned.join(', ') || 'none'}`);
  console.log('\nDry run: nothing written.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--policy');
  const policyPath = at >= 0 ? args[at + 1] : undefined;
  const unknown = args.filter((arg, i) => arg !== '--json' && i !== at && i !== at + 1);
  if (!policyPath || unknown.length > 0) {
    console.error('Usage: pnpm exec tsx scripts/credential-ownership-dry-run.ts --policy <proposed.json> [--json]');
    process.exit(2);
  }
  try {
    process.exit(main(policyPath, args.includes('--json')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
