/**
 * Fleet-wide MCP defaults (`data/fleet-mcp-servers.json`), inherited by every group; adding one is a data edit
 * (`ncl groups config add-mcp-server --fleet`). A group's own container.json entry wins for a name, and its
 * workgroup's or its own `excludeMcpServers` withholds one. The file carries no credential: the OneCLI gateway injects auth.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { validateMcpServerName, validateMcpServers, type McpServerConfig } from './container-config.js';
import { DEFAULT_FLEET_MCP_SERVERS } from './fleet-mcp-default-servers.js';

export const FLEET_MCP_SERVERS_PATH = path.join(DATA_DIR, 'fleet-mcp-servers.json');

interface FleetMcpServersFile {
  version: 1;
  mcpServers: Record<string, McpServerConfig>;
}

/** Must match the agent-runner's `RETIRED_MCP_SERVER_NAMES`, which it drops on every spawn (test-enforced). */
export const RETIRED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['slack-user-token']);

/**
 * Floor for an entry every member of a scope inherits (the fleet file, a workgroup's `mcp_servers`). Deliberately
 * does not normalize: that would change what an entry sends. `where` names the store in the thrown message.
 */
export function validateInheritedMcpServers(
  servers: Record<string, McpServerConfig>,
  where: string,
): Record<string, McpServerConfig> {
  const fail = (message: string): never => {
    throw new Error(`Invalid ${where}: ${message}`);
  };
  const validated = validateMcpServers(servers);
  for (const [name, entry] of Object.entries(validated)) validateInheritedEntry(name, entry, fail);
  return validated;
}

function fleetFail(message: string): never {
  throw new Error(`Invalid fleet MCP defaults at ${FLEET_MCP_SERVERS_PATH}: ${message}`);
}

const FLEET_WHERE = `fleet MCP defaults at ${FLEET_MCP_SERVERS_PATH}`;

function validateInheritedEntry(name: string, entry: McpServerConfig, fail: (message: string) => never): void {
  try {
    validateMcpServerName(name);
  } catch (error) {
    fail(`server name ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (RETIRED_MCP_SERVER_NAMES.has(name)) {
    fail(`server ${JSON.stringify(name)} is retired and is dropped by the agent-runner on every spawn`);
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`server ${name} must be an object`);
  const server = entry as unknown as Record<string, unknown>;
  const hasUrl = typeof server.url === 'string' && server.url.trim() !== '';
  const hasCommand = typeof server.command === 'string' && server.command.trim() !== '';
  if (hasUrl === hasCommand) fail(`server ${name} needs exactly one of url (remote) or command (stdio)`);
  if (server.type !== undefined && server.type !== 'stdio' && server.type !== 'http') {
    fail(`server ${name} has unsupported transport ${JSON.stringify(server.type)}`);
  }
  // A wrong shape here is inherited by every member and fails only inside the container. Unknown keys are refused:
  // `cwd`, `plugin`, `pluginRoot` are per-group plugin provenance an inherited entry can't mean.
  const allowed = new Set(
    hasUrl
      ? ['type', 'url', 'headers', 'instructions', 'displayName', 'description']
      : ['type', 'command', 'args', 'env', 'instructions', 'displayName', 'description'],
  );
  for (const key of Object.keys(server)) {
    if (!allowed.has(key)) fail(`server ${name} has unsupported field ${JSON.stringify(key)}`);
  }
  if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((a) => typeof a === 'string'))) {
    fail(`server ${name} args must be an array of strings`);
  }
  for (const field of ['env', 'headers'] as const) {
    const value = server[field];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`server ${name} ${field} must be an object with string values`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== 'string') fail(`server ${name} ${field} must be an object with string values`);
      // Env keys reach a process environment; header names reach the wire.
      const keyOk =
        field === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key);
      if (!keyOk) fail(`server ${name} ${field} key ${JSON.stringify(key)} is not a valid ${field} name`);
    }
  }
  for (const field of ['instructions', 'description'] as const) {
    if (server[field] !== undefined && typeof server[field] !== 'string')
      fail(`server ${name} ${field} must be a string`);
  }
  if (
    server.displayName !== undefined &&
    (typeof server.displayName !== 'string' || server.displayName.trim() === '')
  ) {
    fail(`server ${name} displayName must be a non-empty string`);
  }

  if (hasUrl) {
    if (server.type === 'stdio') fail(`server ${name} declares type "stdio" with a url`);
    let parsed: URL;
    try {
      parsed = new URL(server.url as string);
    } catch (error) {
      fail(`server ${name} url is not a valid URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Plain HTTP only for a loopback host the gateway never sees.
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      fail(`server ${name} url must use HTTPS (plain HTTP only for localhost and host.docker.internal)`);
    }
  } else if (server.type === 'http') {
    fail(`server ${name} declares type "http" with no url`);
  }
}

function parseFile(contents: string): Record<string, McpServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    fleetFail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fleetFail('top level must be an object');
  const file = raw as Record<string, unknown>;
  if (file.version !== 1) fleetFail('version must be 1');
  if (Object.keys(file).some((key) => key !== 'version' && key !== 'mcpServers')) {
    fleetFail('only version and mcpServers are allowed at the top level');
  }
  const servers = file.mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    fleetFail('mcpServers must be an object keyed by server name');
  }
  return validateInheritedMcpServers(servers as Record<string, McpServerConfig>, FLEET_WHERE);
}

/** A missing file yields the defaults; a malformed one throws rather than silently dropping every group's tools. */
export function readFleetMcpServers(): Record<string, McpServerConfig> {
  let contents: string;
  try {
    contents = fs.readFileSync(FLEET_MCP_SERVERS_PATH, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Copy each entry: `validateMcpServers` mutates entries in place, and these are the module-level defaults.
      return Object.fromEntries(Object.entries(DEFAULT_FLEET_MCP_SERVERS).map(([name, entry]) => [name, { ...entry }]));
    }
    throw error;
  }
  return parseFile(contents);
}

export function updateFleetMcpServers(
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Record<string, McpServerConfig> {
  const servers = readFleetMcpServers();
  mutate(servers);
  const validated = validateInheritedMcpServers(servers, FLEET_WHERE);
  const file: FleetMcpServersFile = { version: 1, mcpServers: validated };
  fs.mkdirSync(path.dirname(FLEET_MCP_SERVERS_PATH), { recursive: true });
  const tmp = `${FLEET_MCP_SERVERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  fs.renameSync(tmp, FLEET_MCP_SERVERS_PATH);
  return servers;
}

/** The fleet entries a member does not inherit: its workgroup's opt-outs plus its own. */
export function excludedFleetMcpServers(
  config: { excludeMcpServers?: string[] } | undefined,
  workgroup: { excludeMcpServers?: readonly string[] } = {},
): Set<string> {
  return new Set([...(workgroup.excludeMcpServers ?? []), ...(config?.excludeMcpServers ?? [])]);
}

/**
 * Shared by the spawn and the capability snapshot. Precedence by name: the group's own entry, then its workgroup's,
 * then the fleet's. Exclusions (`excludedFleetMcpServers`) withhold fleet entries only: a workgroup grant is a floor
 * no member subtracts from. Excludes the host-credential-derived servers `buildContainerArgs` assembles itself from
 * scoped host env.
 */
export function effectiveMcpServers(
  config: { mcpServers?: Record<string, McpServerConfig>; excludeMcpServers?: string[] } | undefined,
  workgroup: { mcpServers?: Record<string, McpServerConfig>; excludeMcpServers?: readonly string[] } = {},
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = { ...(config?.mcpServers ?? {}) };
  for (const [name, entry] of Object.entries(workgroup.mcpServers ?? {})) {
    if (!servers[name]) servers[name] = { ...entry };
  }
  const excluded = excludedFleetMcpServers(config, workgroup);
  for (const [name, entry] of Object.entries(readFleetMcpServers())) {
    if (excluded.has(name) || servers[name]) continue;
    // A copy: `validateMcpServers` mutates in place and could otherwise edit the module-level defaults.
    servers[name] = { ...entry };
  }
  return servers;
}
