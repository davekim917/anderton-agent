import { execFile, execSync, spawn, type ChildProcess, type ExecFileException } from 'child_process';
import os from 'os';

import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
} from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Plain container names only: the blocking stop interpolates the name into a shell command. */
function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/**
 * Bounds on the runtime calls the host makes from its event loop. A daemon under disk pressure can take minutes per
 * call; a call past its bound is killed and fails, so it costs that caller, never the loop.
 */
export const RUNTIME_STOP_TIMEOUT_MS = 30_000;
export const RUNTIME_QUERY_TIMEOUT_MS = 10_000;

let stopTimeoutMs = RUNTIME_STOP_TIMEOUT_MS;
let queryTimeoutMs = RUNTIME_QUERY_TIMEOUT_MS;

export function _setRuntimeTimeoutsForTesting(timeouts: { stopMs?: number; queryMs?: number } = {}): void {
  stopTimeoutMs = timeouts.stopMs ?? RUNTIME_STOP_TIMEOUT_MS;
  queryTimeoutMs = timeouts.queryMs ?? RUNTIME_QUERY_TIMEOUT_MS;
}

export class RuntimeCallTimeoutError extends Error {
  constructor(args: string[], timeoutMs: number, options?: ErrorOptions) {
    super(`${CONTAINER_RUNTIME_BIN} ${args.join(' ')} timed out after ${timeoutMs}ms`, options);
    this.name = 'RuntimeCallTimeoutError';
  }
}

export function runRuntime(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err: ExecFileException | null, stdout: string) => {
        if (!err) resolve(stdout);
        else if (err.killed && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          reject(new RuntimeCallTimeoutError(args, timeoutMs, { cause: err }));
        else reject(err);
      },
    );
  });
}

/**
 * `docker stop -t 1`, escalating to `docker kill` when the stop outlives its bound. Rejects when the stop fails
 * outright (callers keep their own fallback), and with `RuntimeCallTimeoutError` when the escalation fails too: the
 * stop may still be in progress in the daemon either way.
 */
export async function stopContainer(name: string): Promise<void> {
  assertContainerName(name);
  try {
    await runRuntime(['stop', '-t', '1', name], stopTimeoutMs);
  } catch (err) {
    if (!(err instanceof RuntimeCallTimeoutError)) throw err;
    log.warn('docker stop timed out — escalating to docker kill', { containerName: name, timeoutMs: stopTimeoutMs });
    try {
      await runRuntime(['kill', name], queryTimeoutMs);
    } catch (killErr) {
      throw new RuntimeCallTimeoutError(['stop', '-t', '1', name], stopTimeoutMs, { cause: killErr });
    }
  }
}

/** The pre-async stop, for operator scripts run with the host down; the host process uses `stopContainer`. */
function stopContainerBlocking(name: string): void {
  assertContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * SIGKILL by name, the fallback when `stopContainer` failed. For an ADOPTED container there is no `docker run`
 * client to kill, and killing its `docker wait` observer would abandon it rather than stop it.
 */
export async function killContainerHard(name: string): Promise<void> {
  assertContainerName(name);
  await runRuntime(['kill', name], queryTimeoutMs);
}

/**
 * Is a container of THIS install with exactly this name running? A listing, not `docker inspect`: inspect on an
 * auto-removed container throws exactly as a dead daemon does, while an empty listing proves absence. A rejection
 * (including a timeout) means "could not ask", left to callers (the claim fence refuses, the adopted waiter re-arms).
 * The `name=` filter is a substring match, so the exact-name check is made here.
 */
export async function runtimeShowsRunning(name: string): Promise<boolean> {
  assertContainerName(name);
  const output = await runRuntime(
    ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--filter', `name=${name}`, '--format', '{{.Names}}'],
    queryTimeoutMs,
  );
  return output.trim().split('\n').filter(Boolean).includes(name);
}

/**
 * Supervision for a container this host did not spawn: a `docker wait <name>` child whose `close` is the container's
 * terminal. Exit 0 prints the exit code; exit 1 with `No such container` is already gone (terminal); exit 1 with
 * `Cannot connect to the Docker daemon` is NOT terminal: the caller re-reads truth and re-arms.
 */
export function waitForContainerExit(name: string): ChildProcess {
  assertContainerName(name);
  return spawn(CONTAINER_RUNTIME_BIN, ['wait', name], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphans of THIS install only (label `nanoclaw-install=<slug>`), so peer installs never reap each other. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainerBlocking(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

function listInstallContainersStrict(): string[] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new Error('Cannot prove install-scoped container absence: runtime listing failed', { cause: err });
  }
}

export interface InstallContainerScope {
  name: string;
  workgroupId: string | null;
  sessionId: string | null;
  groupId: string | null;
}

/** Docker emits an empty string for a label a container does not carry. */
function labelOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === '<no value>' ? null : trimmed;
}

/**
 * Every install-labeled container with its scope labels, for the boot quiescence door. Fails closed like
 * `listInstallContainersStrict`. A container older than the scope labels reads null in every field but `name`, which
 * the caller must treat as unknown scope.
 */
export async function listInstallContainersWithScope(): Promise<InstallContainerScope[]> {
  const format = [
    '{{.Names}}',
    `{{.Label "${CONTAINER_WORKGROUP_LABEL_KEY}"}}`,
    `{{.Label "${CONTAINER_SESSION_LABEL_KEY}"}}`,
    `{{.Label "${CONTAINER_GROUP_LABEL_KEY}"}}`,
  ].join('\\t');
  let output: string;
  try {
    // No bound: an inventory that times out would fail the boot door closed where a slow one completes.
    output = await runRuntime(['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', format], 0);
  } catch (err) {
    throw new Error('Cannot prove install-scoped container absence: runtime listing failed', { cause: err });
  }
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, workgroupId, sessionId, groupId] = line.split('\t');
      return {
        name: (name ?? '').trim(),
        workgroupId: labelOrNull(workgroupId),
        sessionId: labelOrNull(sessionId),
        groupId: labelOrNull(groupId),
      };
    })
    .filter((entry) => entry.name !== '');
}

/** Stop this install's leftovers and prove quiescence; a precondition for filesystem authority changes, fail-closed. */
export function cleanupOrphansStrict(): string[] {
  const orphans = listInstallContainersStrict();
  for (const name of orphans) {
    try {
      stopContainerBlocking(name);
    } catch (err) {
      throw new Error(`Cannot prove install-scoped container absence: failed to stop ${name}`, { cause: err });
    }
  }
  const remaining = listInstallContainersStrict();
  if (remaining.length > 0) {
    throw new Error(`Install-scoped containers still running after cleanup: ${remaining.join(', ')}`);
  }
  if (orphans.length > 0) {
    log.info('Stopped orphaned containers and proved install quiescence', {
      count: orphans.length,
      names: orphans,
    });
  }
  return orphans;
}
