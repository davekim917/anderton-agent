#!/usr/bin/env node
// Stands in for `claude -p --output-format json`. `replies.json` in CLAUDE_CONFIG_DIR maps a credential value to its
// reply ({ result, isError, apiErrorStatus, raw, exitCode, delayMs }); each invocation is appended to `calls.jsonl`.
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const dir = env.CLAUDE_CONFIG_DIR;
const credential = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
let stdin = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: process.argv.slice(2), env, stdin })}\n`);
  const replies = JSON.parse(fs.readFileSync(path.join(dir, 'replies.json'), 'utf8'));
  const reply = replies[credential] ?? { result: 'unscripted' };
  setTimeout(() => {
    if (reply.raw !== undefined) process.stdout.write(reply.raw);
    else
      process.stdout.write(
        JSON.stringify({
          is_error: reply.isError ?? false,
          result: reply.result,
          api_error_status: reply.apiErrorStatus ?? null,
        }),
      );
    process.exitCode = reply.exitCode ?? (reply.isError ? 1 : 0);
  }, reply.delayMs ?? 0);
});
