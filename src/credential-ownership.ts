/**
 * Which workgroups own each scoped host credential. A `tools` entry alone decides what the spawn stages, so without
 * this a bare `aws` or `google-workspace` reaches every tenant's credentials on the host. data/credential-ownership.json
 * (`{ "version": 1, "credentials": { "<kind>": { "<scope>": ["<workgroup id>", ...] } } }`) names each owned scope's
 * workgroups, and once it exists staging fails closed: a scope is staged only for the workgroups that own it, so a
 * scope nobody owns (including every scope of a kind the file does not name) is staged for no workgroup, and a bare
 * tool or a member with no tools list is staged scope by scope, never as a whole store. No file keeps today's staging;
 * an unparseable file throws so the spawn aborts. Ownership is checked against the spawn's workgroup, never a group or
 * credential folder. The spawn, the capabilities snapshot and the dry-run script all resolve through
 * `stagedCredentialScopes`, so what an agent is told matches what it gets.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { DATA_DIR } from './config.js';
import { extractToolScopes, isToolEnabled } from './scoped-env.js';

export const CREDENTIAL_OWNERSHIP_POLICY_PATH = path.join(DATA_DIR, 'credential-ownership.json');

/**
 * One kind per host credential store the spawn stages by scope. `google-workspace-mcp` is the
 * ~/.google_workspace_mcp/credentials store `google-workspace` also mounts, whose files are named by email.
 */
export const CREDENTIAL_KINDS = [
  'google-workspace',
  'google-workspace-mcp',
  'gmail',
  'calendar',
  'snowflake',
  'aws',
  'dbt',
  'gcloud',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

// Same slug rule as WORKGROUP_ID_RE in src/workgroup-read-access.ts.
const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;
// A profile, section, account or email file stem: no path separators, and not "." or "..".
const SCOPE_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9@._-]+$/;

export type CredentialOwnership = ReadonlyMap<CredentialKind, ReadonlyMap<string, ReadonlySet<string>>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseCredentialOwnership(
  contents: string,
  policyPath: string = CREDENTIAL_OWNERSHIP_POLICY_PATH,
): CredentialOwnership {
  function fail(message: string): never {
    throw new Error(`Invalid credential ownership policy at ${policyPath}: ${message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid credential ownership policy at ${policyPath}: JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isObject(raw)) fail('top level must be an object');
  if (Object.keys(raw).some((key) => key !== 'version' && key !== 'credentials')) {
    fail('only version and credentials are allowed at the top level');
  }
  if (raw.version !== 1) fail('version must be 1');
  if (!isObject(raw.credentials)) fail('credentials must be an object keyed by credential kind');
  const ownership = new Map<CredentialKind, ReadonlyMap<string, ReadonlySet<string>>>();
  for (const [kind, scopes] of Object.entries(raw.credentials)) {
    if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
      fail(`${JSON.stringify(kind)} is not a credential kind (${CREDENTIAL_KINDS.join(', ')})`);
    }
    if (!isObject(scopes)) fail(`${kind} must be an object keyed by scope name`);
    const owners = new Map<string, ReadonlySet<string>>();
    for (const [scope, workgroups] of Object.entries(scopes)) {
      if (!SCOPE_NAME_RE.test(scope)) fail(`${kind} scope ${JSON.stringify(scope)} is not a credential scope name`);
      if (!Array.isArray(workgroups)) fail(`${kind}:${scope} must map to an array of workgroup IDs`);
      const owning = new Set<string>();
      for (const workgroup of workgroups) {
        if (typeof workgroup !== 'string' || !WORKGROUP_ID_RE.test(workgroup)) {
          fail(`${kind}:${scope} lists ${JSON.stringify(workgroup)}, which is not a workgroup slug`);
        }
        owning.add(workgroup);
      }
      owners.set(scope, owning);
    }
    ownership.set(kind as CredentialKind, owners);
  }
  return ownership;
}

/** Reads the policy on every call, so an edit applies at the next spawn. Null when there is no policy file. */
export function loadCredentialOwnership(
  policyPath: string = CREDENTIAL_OWNERSHIP_POLICY_PATH,
): CredentialOwnership | null {
  let contents: string;
  try {
    contents = fs.readFileSync(policyPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Could not read credential ownership policy at ${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseCredentialOwnership(contents, policyPath);
}

/** Whether `workgroupId` may receive `scope` of `kind`: always without a policy, else only if it owns the scope. */
export function credentialScopeAllowed(
  kind: CredentialKind,
  scope: string,
  workgroupId: string,
  ownership: CredentialOwnership | null,
): boolean {
  return !ownership || ownership.get(kind)?.get(scope)?.has(workgroupId) === true;
}

/** The unsuffixed ~/.gmail-mcp account. `@` never appears in a `.gmail-mcp-<name>` tool scope, so it cannot collide. */
export const GMAIL_PRIMARY_SCOPE = '@primary';

export interface StagedScopes {
  scopes: string[];
  /** False: the whole host store as it is, including files no scope names. */
  isScoped: boolean;
  /** gmail only: the scope mounted at /home/node/.gmail-mcp. */
  primary?: string;
}

function requestedScopes(kind: CredentialKind, tools: string[] | undefined): { scopes: string[]; isScoped: boolean } {
  if (kind === 'gmail') {
    const scopes = [
      ...new Set([...extractToolScopes(tools, 'gmail').scopes, ...extractToolScopes(tools, 'gmail-readonly').scopes]),
    ];
    return { scopes, isScoped: scopes.length > 0 && !tools?.includes('gmail') };
  }
  return extractToolScopes(tools, kind === 'google-workspace-mcp' ? 'google-workspace' : kind);
}

function kindEnabled(kind: CredentialKind, tools: string[] | undefined): boolean {
  if (kind === 'gmail') return isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly');
  return isToolEnabled(tools, kind === 'google-workspace-mcp' ? 'google-workspace' : kind);
}

/**
 * What the spawn stages of `kind` for a member with `tools` in `workgroupId`, or null when its tool is off. Without a
 * policy a bare tool is the whole store and a scoped one its named scopes; with one, only the requested (bare: every
 * `available()`) scopes the workgroup owns. `google-workspace-mcp` files are named by email, so a scoped
 * `google-workspace:<prefix>` selects the `available()` stems it prefixes.
 */
export function stagedCredentialScopes(
  kind: CredentialKind,
  tools: string[] | undefined,
  workgroupId: string,
  ownership: CredentialOwnership | null,
  available: () => string[],
): StagedScopes | null {
  if (!kindEnabled(kind, tools)) return null;
  const requested = requestedScopes(kind, tools);
  if (kind === 'google-workspace-mcp' && requested.isScoped) {
    requested.scopes = available().filter((stem) => requested.scopes.some((prefix) => stem.startsWith(prefix)));
  }
  let staged: StagedScopes;
  if (!ownership) {
    staged = requested.isScoped ? requested : { scopes: [], isScoped: false };
  } else {
    const scopes = requested.isScoped ? requested.scopes : [...new Set(available())];
    staged = {
      scopes: scopes.filter((scope) => credentialScopeAllowed(kind, scope, workgroupId, ownership)),
      isScoped: true,
    };
  }
  if (kind !== 'gmail' || !staged.isScoped) return staged;
  const first = requested.isScoped ? requested.scopes[0] : undefined;
  const primary = [GMAIL_PRIMARY_SCOPE, first].find((scope) => scope !== undefined && staged.scopes.includes(scope));
  return primary === undefined ? staged : { ...staged, primary };
}

/** The ~ directory of a gmail scope. */
export function gmailAccountDir(scope: string): string {
  return scope === GMAIL_PRIMARY_SCOPE ? '.gmail-mcp' : `.gmail-mcp-${scope}`;
}

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}

function sectionNames(content: string | null): string[] {
  if (content === null) return [];
  return [...content.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1].trim());
}

/**
 * The scope names of `kind` present on this host, named as the spawn stages them: a `tools` scope suffix for every
 * kind except `google-workspace-mcp`, whose scope is a credential file's email stem. The unsuffixed gmail account is
 * `GMAIL_PRIMARY_SCOPE`. A missing or unparseable store lists none, so a narrowed tool stages nothing from it.
 */
export function hostCredentialScopes(
  kind: CredentialKind,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  switch (kind) {
    case 'google-workspace':
      return listDir(path.join(home, '.config', 'gws', 'accounts')).flatMap((e) => {
        if (e.isDirectory()) return [e.name];
        return e.isFile() && e.name.endsWith('.json') ? [e.name.slice(0, -'.json'.length)] : [];
      });
    case 'google-workspace-mcp':
      return [
        ...new Set(
          listDir(path.join(home, '.google_workspace_mcp', 'credentials'))
            .filter((e) => e.isFile())
            .map((e) => googleWorkspaceMcpStem(e.name)),
        ),
      ];
    case 'gmail':
      return listDir(home).flatMap((e) => {
        if (!e.isDirectory()) return [];
        if (e.name === '.gmail-mcp') return [GMAIL_PRIMARY_SCOPE];
        const suffix = e.name.startsWith('.gmail-mcp-') ? e.name.slice('.gmail-mcp-'.length) : null;
        return suffix !== null && suffix !== GMAIL_PRIMARY_SCOPE ? [suffix] : [];
      });
    case 'calendar': {
      const tokens = readOrNull(path.join(home, '.config', 'google-calendar-mcp', 'tokens.json'));
      try {
        const parsed: unknown = tokens === null ? {} : JSON.parse(tokens);
        return isObject(parsed) ? Object.keys(parsed) : [];
      } catch {
        return [];
      }
    }
    case 'snowflake':
      return sectionNames(readOrNull(path.join(home, '.snowflake', 'connections.toml')));
    case 'aws':
      return [
        ...new Set([
          ...sectionNames(readOrNull(path.join(home, '.aws', 'credentials'))),
          ...sectionNames(readOrNull(path.join(home, '.aws', 'config'))).map((h) => h.replace(/^profile\s+/, '')),
        ]),
      ];
    case 'dbt': {
      const profiles = readOrNull(path.join(home, '.dbt', 'profiles.yml'));
      try {
        const parsed: unknown = profiles === null ? {} : YAML.parse(profiles, { merge: true });
        return isObject(parsed) ? Object.keys(parsed) : [];
      } catch {
        return [];
      }
    }
    case 'gcloud':
      return Object.keys(env).flatMap((key) => {
        const m = key.match(/^GCLOUD_KEY_(.+)$/);
        return m ? [m[1].toLowerCase()] : [];
      });
  }
}

/** `pat@example.com.json` and `pat@example.com.json.gws` are both the `pat@example.com` credential. */
export function googleWorkspaceMcpStem(fileName: string): string {
  const at = fileName.indexOf('.json');
  return at > 0 ? fileName.slice(0, at) : fileName;
}
