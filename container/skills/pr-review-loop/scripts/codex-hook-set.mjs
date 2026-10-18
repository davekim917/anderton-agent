// codex itself answers (`hooks/list`), so feature flags, trust rows and TOML syntax are judged as codex judges them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const home = process.argv[2];
if (!home) {
  console.error('usage: codex-hook-set.mjs <codex-home> [app-server config flags…]');
  process.exit(2);
}

const server = spawn('codex', ['app-server', '--listen', 'stdio://', ...process.argv.slice(3)], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const fail = (message) => {
  console.error(`codex-hook-set: ${home}: ${message}`);
  server.kill('SIGKILL');
  process.exit(1);
};
const timer = setTimeout(() => fail('no hooks/list answer within 30s'), 30_000);
server.on('error', (err) => fail(err.message));
server.on('close', (code) => fail(`app-server exited (${code}) before answering`));

const send = (id, method, params) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
readline.createInterface({ input: server.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1) {
    if (msg.error) fail(`initialize failed: ${msg.error.message}`);
    send(2, 'hooks/list', {});
  } else if (msg.id === 2) {
    if (msg.error) fail(`hooks/list failed: ${msg.error.message}`);
    const groups = msg.result?.data;
    if (!Array.isArray(groups)) fail('hooks/list response has no data array');
    const prefixes = [home, fs.realpathSync(home)].map((dir) => `${dir.replace(/\/+$/, '')}/`);
    const rows = groups
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .filter(
        (hook) => hook?.enabled === true && ['trusted', 'managed'].includes(String(hook.trustStatus).toLowerCase()),
      )
      .map((hook) => {
        const key = String(hook.key);
        const prefix = prefixes.find((p) => key.startsWith(p));
        return `${hook.source ?? ''}\t${prefix ? key.slice(prefix.length) : key}\t${hook.currentHash ?? ''}`;
      });
    clearTimeout(timer);
    server.removeAllListeners('close');
    server.kill('SIGTERM');
    process.stdout.write(rows.length ? `${rows.join('\n')}\n` : '', () => process.exit(0));
  }
});
send(1, 'initialize', { clientInfo: { name: 'codex-exec', version: '1.0.0' }, capabilities: {} });
