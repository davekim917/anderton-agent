/**
 * Host Haiku calls run through the Claude Code CLI on the subscription OAuth slots: on raw `/v1/messages` those tokens
 * serve only older Haiku models to callers that are not Claude Code. Never through the OneCLI gateway: it swaps the
 * credential for one fixed account's, which defeats key rotation.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { EnvHttpProxyAgent, type Dispatcher } from 'undici';

import { DATA_DIR } from './config.js';
import { readEnvFileMatching } from './env.js';
import { DEFAULT_HAIKU_MODEL, vocabFor } from './flag-parser.js';
import { log } from './log.js';

const DEFAULT_SYSTEM_PROMPT = 'Reply with only the requested text.';

let cliOverride: { executable: string; configDir: string } | null = null;

/** Test-only: a fake CLI and a disposable config dir. */
export function _setClaudeCliForTesting(cli: { executable: string; configDir: string } | null): void {
  cliOverride = cli;
}

let _envProxyDispatcher: Dispatcher | null | undefined;
export function getProxyDispatcher(): Dispatcher | null {
  if (_envProxyDispatcher !== undefined) return _envProxyDispatcher;
  const hasProxyEnv = !!(
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
  _envProxyDispatcher = hasProxyEnv ? new EnvHttpProxyAgent() : null;
  return _envProxyDispatcher;
}

export type ClaudeCredentialSlot = 'oauth:primary' | `oauth:${number}` | 'api-key:primary';

interface StructuredCredential {
  slot: ClaudeCredentialSlot;
  authEnv: {
    name: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
    value: string;
  };
}

const ONECLI_CREDENTIAL_PLACEHOLDER = 'placeholder';

function structuredCredentials(env: NodeJS.ProcessEnv, envFile: Record<string, string> = {}): StructuredCredential[] {
  const effectiveEnv = { ...env, ...envFile };
  const oauthCandidates: Array<{ slot: ClaudeCredentialSlot; value: string; order: number }> = [];
  const primaryOauth = effectiveEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? '';
  if (primaryOauth && primaryOauth !== ONECLI_CREDENTIAL_PLACEHOLDER) {
    oauthCandidates.push({ slot: 'oauth:primary', value: primaryOauth, order: 0 });
  }
  for (const [key, rawValue] of Object.entries(effectiveEnv)) {
    const match = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/.exec(key);
    const value = rawValue?.trim() ?? '';
    if (!match || !value || value === ONECLI_CREDENTIAL_PLACEHOLDER) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) continue;
    oauthCandidates.push({ slot: `oauth:${index}`, value, order: index });
  }
  oauthCandidates.sort((a, b) => a.order - b.order);
  const seenOauth = new Set<string>();
  const oauth = oauthCandidates.flatMap(({ slot, value }) => {
    if (seenOauth.has(value)) return [];
    seenOauth.add(value);
    return [
      {
        slot,
        authEnv: { name: 'CLAUDE_CODE_OAUTH_TOKEN' as const, value },
      },
    ];
  });
  if (oauth.length > 0) return oauth;

  const directApiKey = effectiveEnv.ANTHROPIC_API_KEY?.trim() ?? '';
  return directApiKey && directApiKey !== ONECLI_CREDENTIAL_PLACEHOLDER
    ? [
        {
          slot: 'api-key:primary',
          authEnv: { name: 'ANTHROPIC_API_KEY' as const, value: directApiKey },
        },
      ]
    : [];
}

function defaultStructuredCredentialEnvFile(env: NodeJS.ProcessEnv): Record<string, string> {
  return env === process.env ? readEnvFileMatching(/^(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(?:_\d+)?$/) : {};
}

export function listClaudeStructuredCredentialSlots(
  env: NodeJS.ProcessEnv = process.env,
  envFile: Record<string, string> = defaultStructuredCredentialEnvFile(env),
): ClaudeCredentialSlot[] {
  return structuredCredentials(env, envFile).map((credential) => credential.slot);
}

const PROVIDER_MESSAGE_LOG_MAX_CHARS = 300;

function truncateProviderMessage(message: string | null): string | null {
  if (message === null || message.length <= PROVIDER_MESSAGE_LOG_MAX_CHARS) return message;
  return `${message.slice(0, PROVIDER_MESSAGE_LOG_MAX_CHARS)}...`;
}

export class CallHaikuHttpError extends Error {
  readonly status: number;
  readonly providerMessage: string | null;

  constructor(status: number, providerMessage: string | null = null) {
    const shownMessage = truncateProviderMessage(providerMessage);
    super(`callHaiku: Anthropic returned ${status}` + (shownMessage ? `: ${shownMessage}` : ''));
    this.name = 'CallHaikuHttpError';
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  /** Set instead of `result` on an error subtype such as `error_during_execution`. */
  errors?: unknown;
}

/** Whether the `claude` CLI these calls run is on PATH. An install that set up a pasted token may not have it. */
export function claudeCliAvailable(): boolean {
  if (cliOverride) return true;
  return (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .some((dir) => dir !== '' && fs.statSync(path.join(dir, 'claude'), { throwIfNoEntry: false })?.isFile() === true);
}

function cliConfigDir(): string {
  const dir = cliOverride?.configDir ?? path.join(DATA_DIR, 'claude-title-cli');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function callHaikuOnce(
  prompt: string,
  options: Required<Pick<CallHaikuOptions, 'timeoutMs' | 'model'>> & Pick<CallHaikuOptions, 'system'>,
  credential: StructuredCredential,
): Promise<string> {
  const configDir = cliConfigDir();
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? configDir,
    // Keeps the operator's own Claude config (CLAUDE.md, plugins, hooks) out of these calls.
    CLAUDE_CONFIG_DIR: configDir,
    [credential.authEnv.name]: credential.authEnv.value,
    // callHaiku rotates slots itself; the CLI's own retries would outlast the caller's timeout.
    CLAUDE_CODE_MAX_RETRIES: '0',
    DISABLE_AUTOUPDATER: '1',
    // Without it every call adds a background Haiku 4.5 request of its own.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Every title call shares this config dir; no settings key turns auto-memory off, so one thread could leak into another's title.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  if (process.env['ANTHROPIC_BASE_URL']) env['ANTHROPIC_BASE_URL'] = process.env['ANTHROPIC_BASE_URL'];
  const args = [
    '-p',
    '--model',
    options.model,
    ...(vocabFor('claude').effortSupportFor(options.model)?.has('low') === false ? [] : ['--effort', 'low']),
    '--system-prompt',
    options.system ?? DEFAULT_SYSTEM_PROMPT,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--output-format',
    'json',
  ];

  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(cliOverride?.executable ?? 'claude', args, {
        cwd: configDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`callHaiku: claude CLI did not answer within ${options.timeoutMs} ms`));
      }, options.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new Error('callHaiku: no claude CLI on PATH; install it with setup/install-claude.sh', { cause: error }),
          );
        } else reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode, stdout: out, stderr: err });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    },
  );

  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout) as CliResult;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(
      `callHaiku: claude CLI exited ${code} without a result: ${truncateProviderMessage(stderr.trim())}`,
      {
        cause: error,
      },
    );
  }
  if (parsed.is_error || typeof parsed.result !== 'string') {
    const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((e) => typeof e === 'string').join('; ') : '';
    const message = typeof parsed.result === 'string' ? parsed.result : errors || stderr.trim() || null;
    if (typeof parsed.api_error_status === 'number') throw new CallHaikuHttpError(parsed.api_error_status, message);
    throw new Error(`callHaiku: claude CLI failed: ${truncateProviderMessage(message) ?? 'no result'}`);
  }
  return parsed.result.trim();
}

export interface CallHaikuOptions {
  system?: string;
  timeoutMs?: number;
  model?: string;
}

/** One request per configured key, in order; the first success wins. The caller owns any retry or throttling. */
export async function callHaiku(prompt: string, options: CallHaikuOptions = {}): Promise<string> {
  const resolved = {
    system: options.system,
    timeoutMs: options.timeoutMs ?? 15_000,
    model: options.model ?? DEFAULT_HAIKU_MODEL,
  };
  const credentials = structuredCredentials(process.env, defaultStructuredCredentialEnvFile(process.env));
  if (credentials.length === 0) {
    throw new Error(
      'callHaiku: no Anthropic credentials configured (set ANTHROPIC_API_KEY or a CLAUDE_CODE_OAUTH_TOKEN slot)',
    );
  }
  let lastErr: unknown;
  let rateLimitErr: unknown;
  for (const credential of credentials) {
    try {
      return await callHaikuOnce(prompt, resolved, credential);
    } catch (err) {
      lastErr = err;
      if (err instanceof CallHaikuHttpError && err.status === 429) rateLimitErr = err;
      log.info('callHaiku: key failed, trying the next one', {
        slot: credential.slot,
        err: (err as Error).message,
      });
    }
  }
  // A 429 from any key outranks a later different failure: callers' rate-limit handling keys on it.
  throw rateLimitErr ?? lastErr;
}
