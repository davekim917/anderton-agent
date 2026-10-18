import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

/**
 * The fake prints a failed turn the way codex-cli 0.159.2 does (`ERROR: <message>`
 * on stderr, exit 1, nothing on stdout).
 */

const SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/codex-exec.sh');
const LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FAKE_CODEX = `#!/usr/bin/env bash
if [ "$1" = app-server ]; then
  [ -e "$CODEX_HOME/hooks-list-unavailable" ] && exit 1
  while IFS= read -r line; do
    case "$line" in
      *'"id":1,'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
      *'"id":2,'*)
        list="$CODEX_HOME/hooks-list.json"
        on=0
        for arg in "$@"; do case "$arg" in *features.hooks=true) on=1 ;; *features.hooks=false) on=0 ;; esac; done
        [ "$on" = 1 ] && [ -e "$CODEX_HOME/hooks-list.enabled.json" ] && list="$CODEX_HOME/hooks-list.enabled.json"
        printf '{"jsonrpc":"2.0","id":2,"result":{"data":[{"hooks":%s}]}}\n' "$(cat "$list" 2>/dev/null || echo '[]')"
        cat >/dev/null ;;
    esac
  done
  exit 0
fi
stdin=$(cat)
printf '%s\\t%s\\t%s\\n' "$CODEX_HOME" "$*" "$stdin" >>"$FAKE_LOG"
echo "user" >&2
echo "\${FAKE_ECHO:-review this}" >&2
case ":$FAKE_LIMITED:" in
  *":$CODEX_HOME:"*)
    case " $* " in
      *" --color "*) printf '\\033[31mERROR:\\033[0m %s\\n' "$FAKE_LIMIT_MESSAGE" >&2 ;;
      *) echo "ERROR: $FAKE_LIMIT_MESSAGE" >&2 ;;
    esac
    exit 1 ;;
esac
case ":$FAKE_BROKEN:" in
  *":$CODEX_HOME:"*) echo "ERROR: The model is not supported" >&2; exit 1 ;;
esac
echo "verdict from $CODEX_HOME"
`;

function setup(homes: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  for (const name of homes) {
    fs.mkdirSync(path.join(home, name));
    fs.writeFileSync(path.join(home, name, 'auth.json'), '{}');
  }
  return { root, bin, home, log: path.join(root, 'calls.tsv') };
}

function run(
  ctx: ReturnType<typeof setup>,
  args: string[],
  env: { limited?: string[]; broken?: string[]; codexHome?: string; echo?: string; locale?: string } = {},
) {
  const at = (name: string) => path.join(ctx.home, name);
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${ctx.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: ctx.home,
      FAKE_LOG: ctx.log,
      FAKE_LIMIT_MESSAGE: LIMIT,
      FAKE_LIMITED: (env.limited ?? []).map(at).join(':'),
      FAKE_BROKEN: (env.broken ?? []).map(at).join(':'),
      ...(env.codexHome ? { CODEX_HOME: at(env.codexHome) } : {}),
      ...(env.echo ? { FAKE_ECHO: env.echo } : {}),
      ...(env.locale ? { LC_ALL: env.locale } : {}),
    },
  });
  const calls = fs.existsSync(ctx.log)
    ? fs
        .readFileSync(ctx.log, 'utf8')
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => {
          const [home, argv, stdin] = line.split('\t');
          return { home: path.basename(home), argv, stdin };
        })
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

describe('codex-exec.sh', () => {
  it('runs once on the current account when it is not limited', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['-m', 'some-model', 'review this']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([{ home: '.codex', argv: 'exec -m some-model review this', stdin: '' }]);
    expect(r.stdout).toBe(`verdict from ${path.join(ctx.home, '.codex')}\n`);
    expect(r.stderr).toContain(`codex-exec: account=${path.join(ctx.home, '.codex')} exit=0`);
  });

  it('reruns exactly once on ~/.codex-secondary after a usage limit, and prints only that verdict', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['-m', 'some-model', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    expect(r.calls[1].argv).toBe('exec -m some-model review this');
    expect(r.stdout).toBe(`verdict from ${path.join(ctx.home, '.codex-secondary')}\n`);
    expect(r.stderr).toContain(`rerunning once with CODEX_HOME=${path.join(ctx.home, '.codex-secondary')}`);
    expect(r.stderr).toContain(`codex-exec: account=${path.join(ctx.home, '.codex-secondary')} exit=0`);
  });

  it('exits 13 after the second account is limited too, without a third attempt', () => {
    const ctx = setup(['.codex', '.codex-fallback-1', '.codex-secondary']);
    const r = run(ctx, ['review this'], { limited: ['.codex', '.codex-fallback-1', '.codex-secondary'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-fallback-1']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('are both at their Codex usage limit');
  });

  it("takes a container's staged fallbacks in order before ~/.codex-secondary, and skips the current home", () => {
    const ctx = setup(['.codex-fallback-1', '.codex-fallback-2', '.codex-secondary']);
    const r = run(ctx, ['review this'], { codexHome: '.codex-fallback-1', limited: ['.codex-fallback-1'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-fallback-1', '.codex-fallback-2']);
  });

  it('skips a fallback home with no auth.json', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    fs.mkdirSync(path.join(ctx.home, '.codex-fallback-1'));
    const r = run(ctx, ['review this'], { limited: ['.codex'] });
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it('exits 13 and says so when no fallback account exists', () => {
    const ctx = setup(['.codex']);
    const r = run(ctx, ['review this'], { limited: ['.codex'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    expect(r.stderr).toContain('no fallback account has an auth.json');
  });

  describe('from a home whose hooks codex dispatches', () => {
    type Hook = { source: string; key: string; enabled: boolean; trustStatus: string; currentHash: string };
    function hooks(ctx: ReturnType<typeof setup>, name: string, change: (rows: Hook[]) => Hook[] = (rows) => rows) {
      const own = path.join(fs.realpathSync(path.join(ctx.home, name)), 'hooks.json');
      const rows: Hook[] = [
        {
          source: 'user',
          key: `${own}:pre_tool_use:0:0`,
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'sha256:g',
        },
        {
          source: 'plugin',
          key: 'guard@mkt:hooks/h.json:pre_tool_use:0:0',
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'sha256:p',
        },
      ];
      fs.writeFileSync(path.join(ctx.home, name, 'hooks-list.json'), JSON.stringify(change(rows)));
    }

    it('reruns on a fallback under which codex dispatches the same hooks', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it('matches hooks codex reports under the real path of a symlinked current home', () => {
      const ctx = setup(['.codex-real', '.codex-secondary']);
      fs.symlinkSync(path.join(ctx.home, '.codex-real'), path.join(ctx.home, '.codex'));
      hooks(ctx, '.codex-real');
      hooks(ctx, '.codex-secondary');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it('refuses a fallback missing the last of more hooks than one pipe buffer holds', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const many = (name: string, count: number) =>
        hooks(ctx, name, (rows) => [
          ...rows,
          ...Array.from({ length: count }, (_, i) => ({
            ...rows[0],
            key: `${rows[0].key}-${String(i).padStart(5, '0')}`,
          })),
        ]);
      many('.codex', 2000);
      many('.codex-secondary', 1999);
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    });

    it('compares hook sets the same way under any locale', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const plugin = (rows: Hook[], id: string) => ({ ...rows[1], key: `${id}@mkt:hooks/h.json:pre_tool_use:0:0` });
      hooks(ctx, '.codex', (rows) => [rows[0], plugin(rows, 'aa-plugin')]);
      hooks(ctx, '.codex-secondary', (rows) => [rows[0], plugin(rows, 'aa-plugin'), plugin(rows, 'a-plugin')]);
      const r = run(ctx, ['review this'], { limited: ['.codex'], locale: 'en_US.utf8' });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it.each([
      ['holds only a credential', () => {}],
      [
        'has the guard handler untrusted under its own path',
        (ctx: ReturnType<typeof setup>) =>
          hooks(ctx, '.codex-fallback-1', (rows) =>
            rows.map((h) => (h.source === 'user' ? { ...h, trustStatus: 'untrusted' } : h)),
          ),
      ],
      [
        'has hooks disabled',
        (ctx: ReturnType<typeof setup>) =>
          hooks(ctx, '.codex-fallback-1', (rows) => rows.map((h) => ({ ...h, enabled: false }))),
      ],
      [
        'runs a different version of the guard',
        (ctx: ReturnType<typeof setup>) =>
          hooks(ctx, '.codex-fallback-1', (rows) =>
            rows.map((h) => (h.source === 'user' ? { ...h, currentHash: 'sha256:other' } : h)),
          ),
      ],
    ])('refuses a fallback that %s, without running there', (_label, prepare) => {
      const ctx = setup(['.codex-runtime', '.codex-fallback-1']);
      hooks(ctx, '.codex-runtime');
      prepare(ctx);
      const r = run(ctx, ['review this'], { codexHome: '.codex-runtime', limited: ['.codex-runtime'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex-runtime']);
      expect(r.stderr).toContain('no fallback account here is confirmed to dispatch every hook');
    });
  });

  it.each([
    [['-c', 'features.hooks=true', 'review this']],
    [['-c', 'features.hooks=true', '--', '--config=features.hooks=false']],
  ])("judges the fallback under the invocation's own -c overrides, never prompt text (%j)", (args) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const guard = [
      {
        source: 'user',
        key: `${path.join(ctx.home, '.codex', 'hooks.json')}:pre_tool_use:0:0`,
        enabled: true,
        trustStatus: 'trusted',
        currentHash: 'sha256:g',
      },
    ];
    fs.writeFileSync(path.join(ctx.home, '.codex', 'hooks-list.enabled.json'), JSON.stringify(guard));
    const r = run(ctx, args, { limited: ['.codex'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it.each([
    ['-p', 'work'],
    ['--cd', '/tmp'],
    ['--dangerously-bypass-hook-trust'],
    ['-cfeatures.hooks=true'],
    ['--ignore-user-config'],
  ])('does not rotate an invocation whose hooks the check cannot reproduce (%s)', (...flags) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, [...flags, 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it('recognises the current home through a trailing slash and moves to the next fallback', () => {
    const ctx = setup(['.codex-fallback-1', '.codex-fallback-2']);
    const r = run(ctx, ['review this'], { codexHome: '.codex-fallback-1/', limited: ['.codex-fallback-1/'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-fallback-1', '.codex-fallback-2']);
  });

  it.each(['.codex', '.codex-secondary'])(
    'refuses to rerun when codex cannot report the hooks of %s, even with no hooks on either side',
    (unavailable) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      fs.writeFileSync(path.join(ctx.home, unavailable, 'hooks-list-unavailable'), '');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    },
  );

  it('recognises a usage limit printed in color', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['--color', 'always', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it('refuses --json, which moves codex errors off stderr, before running anything', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['--json', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it('passes any other failure through without a rerun', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review this'], { broken: ['.codex'] });
    expect(r.status).toBe(1);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it('does not rerun when the limit sentence only appears in the echoed prompt', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review this'], { broken: ['.codex'], echo: `+ fixture: ${LIMIT}` });
    expect(r.status).toBe(1);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it('feeds --prompt-file to every attempt as stdin', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const prompt = path.join(ctx.root, 'prompt.md');
    fs.writeFileSync(prompt, 'the whole diff');
    const r = run(ctx, ['--prompt-file', prompt, '--', '-m', 'some-model'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      { home: '.codex', argv: 'exec -m some-model', stdin: 'the whole diff' },
      { home: '.codex-secondary', argv: 'exec -m some-model', stdin: 'the whole diff' },
    ]);
  });
});
