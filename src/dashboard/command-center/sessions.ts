/**
 * Live host Claude Code sessions from `~/.claude/sessions/*.json`. Only the contract fields leave this module: the
 * files also carry a messaging socket path, bridge id and pid, and their `*.key` siblings are never opened.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { HostSession, HostSessionStatus } from './types.js';

const STATUS: Record<string, HostSessionStatus> = {
  waiting: 'needs_you',
  busy: 'working',
  idle: 'idle',
  shell: 'shell',
};

const HERDR_TIMEOUT_MS = 2000;

/**
 * A live pid is not enough: a session killed without removing its file leaves a pid the OS can hand to another
 * process. `procStart` is that process's start time as `/proc/<pid>/stat` field 22 reports it, so the two must match,
 * and a record without one cannot be verified and does not count as live.
 */
export function sessionProcessLive(pid: number, procStart: unknown, procRoot = '/proc'): boolean {
  if (typeof procStart !== 'string' || !/^\d+$/.test(procStart)) return false;
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // The command name (field 2) may contain spaces and parentheses, so count fields from the last ')'.
    return (
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(' ')[19] === procStart
    );
  } catch {
    return false;
  }
}

function homeRelative(cwd: string, home: string): string {
  if (cwd === home) return '~';
  return cwd.startsWith(home + path.sep) ? `~${cwd.slice(home.length)}` : cwd;
}

export function readHostSessions(
  dir: string,
  titles: ReadonlyMap<string, string>,
  isAlive: (pid: number, procStart: unknown) => boolean = sessionProcessLive,
  home: string = os.homedir(),
): HostSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions: HostSession[] = [];
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const raw = parsed as Record<string, unknown>;
    const { sessionId, pid, status, cwd } = raw;
    const since = raw.statusUpdatedAt ?? raw.updatedAt;
    const sinceMs = typeof since === 'number' ? new Date(since).getTime() : NaN;
    if (typeof sessionId !== 'string' || typeof pid !== 'number' || Number.isNaN(sinceMs)) continue;
    if (!isAlive(pid, raw.procStart)) continue;
    const fileName = typeof raw.name === 'string' && raw.name ? raw.name : sessionId.slice(0, 8);
    sessions.push({
      session_id: sessionId,
      title: titles.get(sessionId) || fileName,
      cwd: typeof cwd === 'string' ? homeRelative(cwd, home) : '',
      status: (typeof status === 'string' && STATUS[status]) || 'unknown',
      since: new Date(sinceMs).toISOString(),
    });
  }
  return sessions;
}

export function readHerdrTitles(
  command: readonly [string, ...string[]] = ['herdr', 'agent', 'list'],
  timeoutMs = HERDR_TIMEOUT_MS,
): Promise<Map<string, string>> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const titles = new Map<string, string>();
      if (err) return resolve(titles);
      try {
        const agents = (JSON.parse(stdout) as { result?: { agents?: unknown } }).result?.agents;
        if (Array.isArray(agents)) {
          for (const a of agents as { agent_session?: { value?: unknown }; terminal_title_stripped?: unknown }[]) {
            const id = a.agent_session?.value;
            const title = a.terminal_title_stripped;
            if (typeof id === 'string' && typeof title === 'string' && title) titles.set(id, title);
          }
        }
      } catch {
        return resolve(new Map());
      }
      resolve(titles);
    });
  });
}
