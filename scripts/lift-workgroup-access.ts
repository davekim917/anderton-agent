/**
 * Moves access every member of a workgroup already shares up to the workgroup, and reports what members do not share.
 *
 *   pnpm exec tsx scripts/lift-workgroup-access.ts [--workgroup <id>] [--json]            # dry run (default)
 *   pnpm exec tsx scripts/lift-workgroup-access.ts [--workgroup <id>] --apply
 *
 * Run from the install root (paths resolve from the working directory), after the deploy that adds the
 * `workgroups.tools` / `workgroups.mcp_servers` columns. Exit: 0 done, 1 refused or failed, 2 invalid arguments.
 *
 * Per workgroup, over every member except wiki actors (which inherit no workgroup access):
 *   - a OneCLI secret, `tools` entry, MCP server (same name, identical entry), `excludeMcpServers` or
 *     `excludePlugins` entry that EVERY member declares is added to the workgroup;
 *   - a member declaration the workgroup now carries identically is removed from that member's container.json.
 * Every kind of workgroup access and opt-out is a union with the member's own, so neither step changes any member's
 * effective access; the plan is checked for that before anything is written, and the stores are re-read and checked
 * again after. The workgroup is written first: a failure part-way leaves a member with a redundant declaration,
 * never without access or with access it had opted out of.
 *
 * Drift — access or opt-outs some members hold and others do not, and credential lookups or mounts that differ — is
 * only reported. Lifting it would change what a member gets today.
 */
import { isDeepStrictEqual } from 'node:util';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../src/config.js';
import {
  readContainerConfigStrict,
  writeContainerConfigJson,
  type ContainerConfig,
  type McpServerConfig,
} from '../src/container-config.js';
import { addWorkgroupOnecliSecret, getAllAgentGroups } from '../src/db/agent-groups.js';
import {
  addWorkgroupExclusion,
  addWorkgroupTool,
  getAllWorkgroupAccessRows,
  putWorkgroupMcpServer,
} from '../src/db/workgroup-access.js';
import { closeDb, getDb, initDb } from '../src/db/connection.js';
import { effectiveMcpServers, excludedFleetMcpServers, validateInheritedMcpServers } from '../src/fleet-mcp-servers.js';
import { mergeWorkgroupAndGroupSecrets } from '../src/onecli-secrets.js';
import { flowctlDeclared } from '../src/flowctl-credential.js';
import { effectiveExcludePlugins } from '../src/plugin-exclusions.js';
import { effectiveTools, parseWorkgroupAccessRow, type WorkgroupAccess } from '../src/workgroup-access.js';

type MemberConfig = Partial<
  Pick<
    ContainerConfig,
    | 'onecliSecrets'
    | 'tools'
    | 'mcpServers'
    | 'excludeMcpServers'
    | 'excludePlugins'
    | 'credentialFolder'
    | 'additionalMounts'
    | 'wikiMaintenance'
  >
>;

export interface MemberInput {
  id: string;
  folder: string;
  config: MemberConfig;
}

interface MemberEdit {
  id: string;
  folder: string;
  removeSecrets: string[];
  removeTools: string[];
  removeMcpServers: string[];
  removeExcludeMcpServers: string[];
  removeExcludePlugins: string[];
}

interface DriftItem {
  kind:
    | 'secret'
    | 'tool'
    | 'mcp-server'
    | 'mcp-server-variant'
    | 'exclude-plugin'
    | 'exclude-mcp-server'
    | 'credential-folder'
    | 'mounts';
  name: string;
  /** Members holding it (for a restriction: members whose setting differs from the most common one). */
  holders: string[];
  /** Members without it, effective access counted. */
  missing: string[];
  detail: string;
}

export interface WorkgroupLiftPlan {
  workgroup: string;
  members: string[];
  excluded: { folder: string; reason: string }[];
  lift: Pick<WorkgroupAccess, 'onecliSecrets' | 'tools' | 'mcpServers' | 'excludeMcpServers' | 'excludePlugins'>;
  edits: MemberEdit[];
  /** Declared by some members only, already carried for every member by the workgroup: removed, nothing changes. */
  covered: { kind: CoveredKind; name: string; declaredBy: string[] }[];
  skipped: { kind: 'mcp-server' | 'exclude-mcp-server'; name: string; reason: string }[];
  drift: DriftItem[];
  /** Members whose effective access the plan would change; must be empty for the plan to be applied. */
  violations: string[];
}

function intersect(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists;
  return [...new Set(first)].filter((item) => rest.every((list) => list.includes(item)));
}

/** A workgroup MCP entry must carry no per-group plugin provenance and pass the inherited-entry floor. */
function liftableMcpReason(workgroup: string, name: string, entry: McpServerConfig): string | null {
  const raw = entry as unknown as Record<string, unknown>;
  for (const field of ['plugin', 'pluginRoot', 'cwd']) {
    if (raw[field] !== undefined) return `carries per-group plugin field "${field}"`;
  }
  try {
    validateInheritedMcpServers({ [name]: structuredClone(entry) }, `workgroup ${workgroup} mcp_servers`);
    return null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the refusal is the answer: the entry stays per group
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type CoveredKind = 'secret' | 'tool' | 'mcp-server' | 'exclude-mcp-server' | 'exclude-plugin';

interface EffectiveAccess {
  secrets: string[];
  tools: string[] | undefined;
  flowctl: boolean;
  mcpServers: Record<string, McpServerConfig>;
  excludedMcpServers: string[];
  excludedPlugins: string[];
}

/** The spawn's own resolvers, so the check measures what a container would get. */
function effectiveAccess(access: WorkgroupAccess, config: MemberConfig): EffectiveAccess {
  return {
    secrets: [...mergeWorkgroupAndGroupSecrets(access.onecliSecrets, config.onecliSecrets)].sort(),
    tools: effectiveTools(access.tools, config.tools)?.slice().sort(),
    flowctl: flowctlDeclared(access.tools, config.tools),
    mcpServers: effectiveMcpServers(config, access),
    excludedMcpServers: [...excludedFleetMcpServers(config, access)].sort(),
    excludedPlugins: effectiveExcludePlugins(access.excludePlugins, config.excludePlugins).sort(),
  };
}

function applyEdit(config: MemberConfig, edit: MemberEdit): MemberConfig {
  const servers = { ...(config.mcpServers ?? {}) };
  for (const name of edit.removeMcpServers) delete servers[name];
  return {
    ...config,
    onecliSecrets: config.onecliSecrets?.filter((s) => !edit.removeSecrets.includes(s)),
    tools: config.tools?.filter((t) => !edit.removeTools.includes(t)),
    mcpServers: servers,
    excludeMcpServers: config.excludeMcpServers?.filter((n) => !edit.removeExcludeMcpServers.includes(n)),
    excludePlugins: config.excludePlugins?.filter((p) => !edit.removeExcludePlugins.includes(p)),
  };
}

function editSize(edit: MemberEdit): number {
  return (
    edit.removeSecrets.length +
    edit.removeTools.length +
    edit.removeMcpServers.length +
    edit.removeExcludeMcpServers.length +
    edit.removeExcludePlugins.length
  );
}

/** What each member could drop because `access` carries it identically. */
function redundantDeclarations(access: WorkgroupAccess, member: MemberInput): MemberEdit {
  const own = member.config;
  return {
    id: member.id,
    folder: member.folder,
    removeSecrets: (own.onecliSecrets ?? []).filter((s) => access.onecliSecrets.includes(s)),
    removeTools: (own.tools ?? []).filter((t) => access.tools.includes(t)),
    removeMcpServers: Object.entries(own.mcpServers ?? {})
      .filter(([name, entry]) => access.mcpServers[name] && isDeepStrictEqual(access.mcpServers[name], entry))
      .map(([name]) => name),
    removeExcludeMcpServers: (own.excludeMcpServers ?? []).filter((n) => access.excludeMcpServers.includes(n)),
    removeExcludePlugins: (own.excludePlugins ?? []).filter((p) => access.excludePlugins.includes(p)),
  };
}

function settingDrift(
  members: MemberInput[],
  kind: DriftItem['kind'],
  name: string,
  value: (m: MemberInput) => unknown,
  describe: (v: unknown) => string,
): DriftItem[] {
  const groups = new Map<string, { value: unknown; folders: string[] }>();
  for (const m of members) {
    const v = value(m);
    const key = JSON.stringify(v);
    const entry = groups.get(key) ?? { value: v, folders: [] };
    entry.folders.push(m.folder);
    groups.set(key, entry);
  }
  if (groups.size <= 1) return [];
  const ranked = [...groups.values()].sort((a, b) => b.folders.length - a.folders.length);
  const [common, ...others] = ranked;
  return others.map((other) => ({
    kind,
    name,
    holders: other.folders,
    missing: common.folders,
    detail: `${other.folders.join(', ')}: ${describe(other.value)}; ${common.folders.join(', ')}: ${describe(common.value)}`,
  }));
}

/** Pure: everything the dry run prints and the apply step writes. */
export function planWorkgroupLift(workgroup: string, access: WorkgroupAccess, all: MemberInput[]): WorkgroupLiftPlan {
  const excluded = all
    .filter((m) => m.config.wikiMaintenance === true)
    .map((m) => ({ folder: m.folder, reason: 'wiki actor: runs the base runtime and inherits no workgroup access' }));
  const members = all.filter((m) => m.config.wikiMaintenance !== true);
  const skipped: WorkgroupLiftPlan['skipped'] = [];

  const sharedSecrets = intersect(members.map((m) => m.config.onecliSecrets ?? []));
  // A member with no tools list already has every surface, so it neither constrains nor receives a tools lift.
  const listed = members.filter((m) => m.config.tools !== undefined);
  const sharedTools = intersect(listed.map((m) => m.config.tools ?? [])).filter(
    (t) => t !== 'flowctl' || listed.length === members.length,
  );

  const liftedServers: Record<string, McpServerConfig> = {};
  if (members.length > 0) {
    const [first, ...rest] = members;
    for (const [name, entry] of Object.entries(first.config.mcpServers ?? {})) {
      if (!rest.every((m) => isDeepStrictEqual(m.config.mcpServers?.[name], entry))) continue;
      if (access.mcpServers[name]) {
        if (!isDeepStrictEqual(access.mcpServers[name], entry)) {
          skipped.push({
            kind: 'mcp-server',
            name,
            reason: 'the workgroup already declares a different entry under this name (each member keeps its own)',
          });
        }
        continue;
      }
      const reason = liftableMcpReason(workgroup, name, entry);
      if (reason) {
        skipped.push({ kind: 'mcp-server', name, reason });
        continue;
      }
      liftedServers[name] = entry;
    }
  }

  const grantedServers = { ...access.mcpServers, ...liftedServers };
  const liftedExcludeMcpServers: string[] = [];
  for (const name of intersect(members.map((m) => m.config.excludeMcpServers ?? []))) {
    if (access.excludeMcpServers.includes(name)) continue;
    // `ncl groups config add-exclusion` refuses this too: a workgroup's own entry is never withheld.
    if (grantedServers[name]) {
      skipped.push({ kind: 'exclude-mcp-server', name, reason: 'the workgroup grants this MCP server itself' });
      continue;
    }
    liftedExcludeMcpServers.push(name);
  }

  const lift: WorkgroupLiftPlan['lift'] = {
    onecliSecrets: sharedSecrets.filter((s) => !access.onecliSecrets.includes(s)),
    tools: sharedTools.filter((t) => !access.tools.includes(t)),
    mcpServers: liftedServers,
    excludeMcpServers: liftedExcludeMcpServers,
    excludePlugins: intersect(members.map((m) => m.config.excludePlugins ?? [])).filter(
      (p) => !access.excludePlugins.includes(p),
    ),
  };
  const after: WorkgroupAccess = {
    onecliSecrets: [...access.onecliSecrets, ...lift.onecliSecrets],
    tools: [...access.tools, ...lift.tools],
    mcpServers: grantedServers,
    excludeMcpServers: [...access.excludeMcpServers, ...lift.excludeMcpServers],
    excludePlugins: [...access.excludePlugins, ...lift.excludePlugins],
  };

  const edits = members.map((m) => redundantDeclarations(after, m)).filter((e) => editSize(e) > 0);

  const covered: WorkgroupLiftPlan['covered'] = [];
  const coveredBy = (kind: CoveredKind, names: (m: MemberInput) => string[]): void => {
    const holders = new Map<string, string[]>();
    for (const m of members) for (const n of names(m)) holders.set(n, [...(holders.get(n) ?? []), m.folder]);
    for (const [name, declaredBy] of holders) {
      if (declaredBy.length < members.length) covered.push({ kind, name, declaredBy });
    }
  };
  coveredBy('secret', (m) => (m.config.onecliSecrets ?? []).filter((s) => access.onecliSecrets.includes(s)));
  coveredBy('tool', (m) => (m.config.tools ?? []).filter((t) => access.tools.includes(t)));
  coveredBy('mcp-server', (m) =>
    Object.entries(m.config.mcpServers ?? {})
      .filter(([name, entry]) => access.mcpServers[name] && isDeepStrictEqual(access.mcpServers[name], entry))
      .map(([name]) => name),
  );
  coveredBy('exclude-mcp-server', (m) =>
    (m.config.excludeMcpServers ?? []).filter((n) => access.excludeMcpServers.includes(n)),
  );
  coveredBy('exclude-plugin', (m) => (m.config.excludePlugins ?? []).filter((p) => access.excludePlugins.includes(p)));

  const remaining = members.map((m) => {
    const edit = edits.find((e) => e.id === m.id);
    return { ...m, config: edit ? applyEdit(m.config, edit) : m.config };
  });

  const drift: DriftItem[] = [];
  const holdersOf = (names: (m: MemberInput) => string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const m of remaining) for (const n of names(m)) map.set(n, [...(map.get(n) ?? []), m.folder]);
    return map;
  };
  for (const [name, holders] of holdersOf((m) => m.config.onecliSecrets ?? [])) {
    if (holders.length === remaining.length) continue;
    drift.push({
      kind: 'secret',
      name,
      holders,
      missing: remaining.filter((m) => !holders.includes(m.folder)).map((m) => m.folder),
      detail: 'OneCLI secret declared by some members only',
    });
  }
  for (const [name, holders] of holdersOf((m) => m.config.tools ?? [])) {
    const missing = remaining.filter((m) =>
      name === 'flowctl'
        ? !flowctlDeclared(after.tools, m.config.tools)
        : m.config.tools !== undefined && !holders.includes(m.folder),
    );
    if (missing.length === 0) continue;
    drift.push({
      kind: 'tool',
      name,
      holders,
      missing: missing.map((m) => m.folder),
      detail: 'tools entry declared by some members only',
    });
  }
  for (const [name, holders] of holdersOf((m) => Object.keys(m.config.mcpServers ?? {}))) {
    if (after.mcpServers[name]) {
      drift.push({
        kind: 'mcp-server-variant',
        name,
        holders,
        missing: [],
        detail: 'these members override the workgroup entry with their own',
      });
      continue;
    }
    const missing = remaining.filter((m) => !holders.includes(m.folder)).map((m) => m.folder);
    const variants = new Set(
      holders.map((f) => JSON.stringify(remaining.find((m) => m.folder === f)?.config.mcpServers?.[name])),
    );
    if (missing.length > 0) {
      drift.push({ kind: 'mcp-server', name, holders, missing, detail: 'MCP server declared by some members only' });
    } else if (variants.size > 1) {
      drift.push({
        kind: 'mcp-server-variant',
        name,
        holders,
        missing: [],
        detail: 'every member declares it, with different entries',
      });
    }
  }
  for (const [kind, list] of [
    ['exclude-mcp-server', (m: MemberInput) => m.config.excludeMcpServers ?? []],
    ['exclude-plugin', (m: MemberInput) => m.config.excludePlugins ?? []],
  ] as const) {
    for (const [name, holders] of holdersOf(list)) {
      if (holders.length === remaining.length) continue;
      drift.push({
        kind,
        name,
        holders,
        missing: remaining.filter((m) => !holders.includes(m.folder)).map((m) => m.folder),
        detail: 'withheld from some members only',
      });
    }
  }
  const memberFolders = new Set(members.map((m) => m.folder));
  for (const m of members) {
    const folder = m.config.credentialFolder;
    if (folder === undefined || memberFolders.has(folder)) continue;
    drift.push({
      kind: 'credential-folder',
      name: 'credentialFolder',
      holders: [m.folder],
      missing: [],
      detail: `${m.folder} looks up credentials under "${folder}", which is not a member's folder: its spawn is refused`,
    });
  }
  const describeList = (v: unknown): string => ((v as string[]).length ? (v as string[]).join(', ') : '(none)');
  drift.push(
    ...settingDrift(
      members,
      'credential-folder',
      'credentialFolder',
      (m) => m.config.credentialFolder ?? m.folder,
      (v) => `scoped host credentials looked up under "${String(v)}"`,
    ),
    ...settingDrift(
      members,
      'mounts',
      'additionalMounts',
      (m) => (m.config.additionalMounts ?? []).map((x) => `${x.hostPath}:${x.containerPath}`).sort(),
      describeList,
    ),
  );

  const violations = members
    .filter(
      (m, i) => !isDeepStrictEqual(effectiveAccess(access, m.config), effectiveAccess(after, remaining[i].config)),
    )
    .map((m) => m.folder);

  return {
    workgroup,
    members: members.map((m) => m.folder),
    excluded,
    lift,
    edits,
    covered,
    skipped,
    drift,
    violations,
  };
}

function formatPlan(plan: WorkgroupLiftPlan): string {
  const lines = [`Workgroup ${plan.workgroup} (${plan.members.length} members: ${plan.members.join(', ') || '-'})`];
  for (const x of plan.excluded) lines.push(`  excluded ${x.folder}: ${x.reason}`);
  const liftLines = [
    ['onecli_secrets     ', plan.lift.onecliSecrets],
    ['tools              ', plan.lift.tools],
    ['mcp_servers        ', Object.keys(plan.lift.mcpServers)],
    ['exclude_mcp_servers', plan.lift.excludeMcpServers],
    ['exclude_plugins    ', plan.lift.excludePlugins],
  ] as const;
  if (liftLines.every(([, names]) => names.length === 0)) {
    lines.push('  lift: nothing new to add to the workgroup');
  } else {
    lines.push('  lift to the workgroup:');
    for (const [column, names] of liftLines) if (names.length) lines.push(`    ${column} + ${names.join(', ')}`);
  }
  if (plan.edits.length === 0) {
    lines.push('  remove from members: nothing');
  } else {
    lines.push('  remove from members (the workgroup carries them identically):');
    for (const e of plan.edits) {
      const parts = [
        e.removeSecrets.length ? `secrets ${e.removeSecrets.join(', ')}` : '',
        e.removeTools.length ? `tools ${e.removeTools.join(', ')}` : '',
        e.removeMcpServers.length ? `mcp_servers ${e.removeMcpServers.join(', ')}` : '',
        e.removeExcludeMcpServers.length ? `excludeMcpServers ${e.removeExcludeMcpServers.join(', ')}` : '',
        e.removeExcludePlugins.length ? `excludePlugins ${e.removeExcludePlugins.join(', ')}` : '',
      ].filter(Boolean);
      lines.push(`    ${e.folder}: ${parts.join('; ')}`);
    }
  }
  for (const c of plan.covered) {
    lines.push(
      `  covered ${c.kind} ${c.name}: declared only by ${c.declaredBy.join(', ')}, but the workgroup already carries it for every member`,
    );
  }
  for (const x of plan.skipped) lines.push(`  not lifted ${x.kind} ${x.name}: ${x.reason}`);
  lines.push(
    plan.violations.length
      ? `  effective access: WOULD CHANGE for ${plan.violations.join(', ')} — refusing`
      : '  effective access: unchanged for every member',
  );
  if (plan.drift.length === 0) {
    lines.push('  drift: none');
  } else {
    lines.push('  drift (reported, not changed):');
    for (const d of plan.drift) {
      const who = d.missing.length ? ` — held by ${d.holders.join(', ')}; missing on ${d.missing.join(', ')}` : '';
      const tail = d.kind === 'credential-folder' || d.kind === 'mounts' ? `: ${d.detail}` : `${who} (${d.detail})`;
      lines.push(`    ${d.kind} ${d.name}${tail}`);
    }
  }
  return lines.join('\n');
}

interface Options {
  apply: boolean;
  json: boolean;
  workgroup?: string;
}

function parseArgv(argv: string[]): Options | null {
  const options: Options = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--workgroup' && argv[i + 1] && !argv[i + 1].startsWith('-')) options.workgroup = argv[++i];
    else return null;
  }
  return options;
}

async function loadInputs(
  only: string | undefined,
): Promise<{ workgroup: string; access: WorkgroupAccess; members: MemberInput[] }[]> {
  const groups = await getAllAgentGroups();
  const rows = await getAllWorkgroupAccessRows();
  return rows
    .filter((row) => only === undefined || row.id === only)
    .map((row) => ({
      workgroup: row.id,
      access: parseWorkgroupAccessRow(row.id, row),
      // Strict: a missing or malformed container.json must stop the run, not read as an empty grant list.
      members: groups
        .filter((g) => g.workgroup_id === row.id)
        .map((g) => ({ id: g.id, folder: g.folder, config: readContainerConfigStrict(g.folder) })),
    }));
}

async function applyPlan(plan: WorkgroupLiftPlan): Promise<void> {
  for (const secret of plan.lift.onecliSecrets) await addWorkgroupOnecliSecret(plan.workgroup, secret);
  for (const tool of plan.lift.tools) await addWorkgroupTool(plan.workgroup, tool);
  for (const [name, entry] of Object.entries(plan.lift.mcpServers)) {
    await putWorkgroupMcpServer(plan.workgroup, name, entry, { replace: false });
  }
  for (const name of plan.lift.excludeMcpServers) {
    await addWorkgroupExclusion(plan.workgroup, 'exclude_mcp_servers', name);
  }
  for (const entry of plan.lift.excludePlugins) await addWorkgroupExclusion(plan.workgroup, 'exclude_plugins', entry);
  const [row] = (await getAllWorkgroupAccessRows()).filter((r) => r.id === plan.workgroup);
  const granted = parseWorkgroupAccessRow(plan.workgroup, row);
  for (const edit of plan.edits) {
    // Recomputed under the file lock against the workgroup as written, so a concurrent edit is never undone.
    await writeContainerConfigJson(edit.id, edit.folder, (config) => {
      const redundant = redundantDeclarations(granted, { id: edit.id, folder: edit.folder, config });
      Object.assign(config, applyEdit(config, redundant));
    });
  }
}

async function main(options: Options): Promise<number> {
  await initDb(path.join(DATA_DIR, 'v2.db'), { role: 'tool' });
  try {
    const columns = new Set(
      (await getDb().all<{ name: string }>('PRAGMA table_info(workgroups)')).map((column) => column.name),
    );
    const required = ['tools', 'mcp_servers', 'exclude_mcp_servers', 'exclude_plugins'];
    const absent = required.filter((column) => !columns.has(column));
    if (absent.length > 0) {
      console.error(`workgroups is missing ${absent.join(', ')}: deploy this build and restart the host first.`);
      return 1;
    }
    const inputs = await loadInputs(options.workgroup);
    if (options.workgroup && inputs.length === 0) {
      console.error(`No workgroup: ${options.workgroup}`);
      return 1;
    }
    const plans = inputs.map((input) => planWorkgroupLift(input.workgroup, input.access, input.members));
    if (options.json) console.log(JSON.stringify(plans, null, 2));
    else console.log(plans.map(formatPlan).join('\n\n'));

    const refused = plans.filter((plan) => plan.violations.length > 0);
    if (refused.length > 0) {
      console.error(
        `Refusing: the plan would change effective access in ${refused.map((p) => p.workgroup).join(', ')}.`,
      );
      return 1;
    }
    if (!options.apply) {
      if (!options.json) console.log('\nDry run: nothing written. Re-run with --apply to write.');
      return 0;
    }

    for (const plan of plans) await applyPlan(plan);
    const reread = await loadInputs(options.workgroup);
    let changed = false;
    for (const input of inputs) {
      const now = reread.find((r) => r.workgroup === input.workgroup);
      for (const member of input.members) {
        const nowMember = now?.members.find((m) => m.id === member.id);
        if (member.config.wikiMaintenance === true) continue;
        if (
          !now ||
          !nowMember ||
          !isDeepStrictEqual(
            effectiveAccess(input.access, member.config),
            effectiveAccess(now.access, nowMember.config),
          )
        ) {
          console.error(
            `Effective access changed for ${member.folder} (workgroup ${input.workgroup}) — inspect it now.`,
          );
          changed = true;
        }
      }
    }
    if (changed) return 1;
    console.log('\nApplied. Effective access re-read from the stores: unchanged for every member.');
    return 0;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgv(process.argv.slice(2));
  if (!options) {
    console.error('Usage: pnpm exec tsx scripts/lift-workgroup-access.ts [--workgroup <id>] [--json] [--apply]');
    process.exit(2);
  }
  process.exit(await main(options));
}
