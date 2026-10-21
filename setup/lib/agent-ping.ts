/**
 * Round-trip check against the CLI Unix socket.
 *
 * Shared by `setup/verify.ts` (end-of-run health check) and `setup/auto.ts`
 * (confirm the freshly-wired agent actually responds before prompting the
 * user to chat with it).
 *
 * Exit-code contract follows `scripts/chat.ts`:
 *   0  → got a reply on stdout
 *   2  → socket unreachable (service not running or wrong checkout)
 *   3  → no reply before chat.ts's own 120s hard stop
 * This wrapper also guards with its own timeout in case chat.ts hangs.
 */
import { spawn } from 'child_process';

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error' | 'agent_error';

// The agent-runner's reply when a turn fails (container/agent-runner/src/poll-loop.ts).
const TURN_ERROR = /^\u26A0\uFE0F? Turn ended with an error:/mu;

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (
    /Invalid bearer token/i.test(output) ||
    /authentication[_ ]error/i.test(output) ||
    /Failed to authenticate/i.test(output) ||
    /Please run \/login/i.test(output) ||
    /Not logged in/i.test(output) ||
    /Invalid API key/i.test(output)
  ) {
    return 'auth_error';
  }
  if (exitCode === 2) return 'socket_error';
  if (TURN_ERROR.test(stdout)) return 'agent_error';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

export function describePingFailure(result: Exclude<PingResult, 'ok'>): {
  headline: string;
  note: string;
  diagnosis: string;
  hint: string;
} {
  switch (result) {
    case 'socket_error':
      return {
        headline: "Couldn't reach the NanoClaw service.",
        note: "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
        diagnosis: "NanoClaw service isn't listening on its CLI socket.",
        hint: 'Socket at data/cli.sock did not accept a connection.',
      };
    case 'auth_error':
      return {
        headline: 'Your assistant has no credentials yet.',
        note: 'Your assistant started, but its provider turned it away: sign in to your provider by re-running setup (`bash nanoclaw.sh`), then chat with `pnpm run chat hi`.',
        diagnosis: "The assistant's provider refused its credentials.",
        hint: 'Provider sign-in was skipped, or the stored credential was rejected.',
      };
    case 'agent_error':
      return {
        headline: 'Your assistant replied with an error.',
        note: "Your assistant's first turn ended with an error instead of a reply. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.",
        diagnosis: "The assistant's first turn ended with an error.",
        hint: 'The agent provider failed the turn; the error is in its reply and in logs/nanoclaw.log.',
      };
    case 'no_reply':
      return {
        headline: "Your assistant didn't reply in time.",
        note: 'No reply from your assistant within 30 seconds. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
        diagnosis: 'No reply from the assistant within 30 seconds.',
        hint: 'Agent container may be failing to start or authenticate.',
      };
  }
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve('no_reply');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(classifyPingResult(code, stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('socket_error');
    });
  });
}
