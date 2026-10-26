import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCodexPluginHooks, GENERATED_CODEX_HOOKS } from './plugin-hook-delivery.js';

let root: string;
let dir: string;
let savedEnv: NodeJS.ProcessEnv;

const CLAUDE_CMD = '[ ! -f "${CLAUDE_PLUGIN_ROOT}/skills/d/scripts/d" ] || "${CLAUDE_PLUGIN_ROOT}/skills/d/scripts/d" hook';
const TEMPLATE_CMD = '[ ! -f ".codex/skills/d/scripts/d" ] || ".codex/skills/d/scripts/d" hook';
const MANIFEST = { name: 'd', skills: './skills/' };

function writeJson(rel: string, value: unknown): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8'));
}

function template(command: string): void {
  writeJson('.codex/hooks.json', {
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command, commandWindows: 'cmd /c x', timeout: 7 }] },
      ],
    },
  });
}

/** A Codex-registrable repo whose Claude marketplace publishes `./plugin`, plus a per-project Codex hooks template. */
function seed(opts: { templateCommand?: string; trackManifest?: boolean } = {}): void {
  writeJson('.claude-plugin/plugin.json', { name: 'd' });
  writeJson('.claude-plugin/marketplace.json', { plugins: [{ name: 'd', source: './plugin' }] });
  writeJson('plugin/.claude-plugin/plugin.json', { name: 'd' });
  writeJson('plugin/hooks/hooks.json', {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: CLAUDE_CMD, timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: CLAUDE_CMD, timeout: 5 }] }],
    },
  });
  writeJson('.agents/plugins/marketplace.json', {
    name: 'd',
    plugins: [{ name: 'd', source: { source: 'local', path: './' } }],
  });
  writeJson('.codex-plugin/plugin.json', MANIFEST);
  template(opts.templateCommand ?? TEMPLATE_CMD);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  if (opts.trackManifest) {
    git('add', '.codex-plugin/plugin.json');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'x');
  }
}

const GENERATED = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Edit|Write|apply_patch',
        hooks: [
          {
            type: 'command',
            command: '[ ! -f "${PLUGIN_ROOT}/plugin/skills/d/scripts/d" ] || "${PLUGIN_ROOT}/plugin/skills/d/scripts/d" hook',
            timeout: 7,
          },
        ],
      },
    ],
  },
};

beforeEach(() => {
  savedEnv = process.env;
  process.env = Object.fromEntries(Object.entries(savedEnv).filter(([k]) => !k.startsWith('GIT_')));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hook-delivery-'));
  process.env.HOME = root;
  dir = path.join(root, 'plugins', 'd');
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureCodexPluginHooks', () => {
  it("rebases the published Claude hook onto Codex's plugin root, and reports what a container trusts", () => {
    seed();

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events: ['post_tool_use'], generated: true, reason: null });
    expect(readJson('.codex-plugin/plugin.json')).toEqual({ ...MANIFEST, hooks: `./${GENERATED_CODEX_HOOKS}` });
    expect(readJson(GENERATED_CODEX_HOOKS)).toEqual(GENERATED);
  });

  it('generates nothing when the template runs a command the Claude hooks do not', () => {
    seed({ templateCommand: '".codex/skills/d/scripts/d" lint' });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({
      events: [],
      generated: false,
      reason: ".codex/hooks.json runs no command the plugin's Claude hooks run",
    });
    expect(fs.existsSync(path.join(dir, GENERATED_CODEX_HOOKS))).toBe(false);
  });

  it("never edits a Codex manifest the plugin's own repo tracks", () => {
    seed({ trackManifest: true });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({
      events: [],
      generated: false,
      reason: 'plugin ships its own Codex manifest without hooks',
    });
    expect(readJson('.codex-plugin/plugin.json')).toEqual(MANIFEST);
  });

  it.each([
    ['an unrelated event', { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, ['session_start']],
    [
      'the same handler under a different matcher',
      { PostToolUse: [{ hooks: [{ type: 'command', command: '/opt/x/d hook' }] }] },
      ['post_tool_use'],
    ],
  ])('never generates beside a conventional hooks file running %s', (_label, conventional, events) => {
    seed();
    writeJson('hooks/hooks.json', { hooks: conventional });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events, generated: false, reason: null });
    expect(readJson('.codex-plugin/plugin.json')).toEqual(MANIFEST);
    expect(fs.existsSync(path.join(dir, GENERATED_CODEX_HOOKS))).toBe(false);
  });

  it('generates beside a conventional file whose only event Codex does not run', () => {
    seed();
    writeJson('hooks/hooks.json', { hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }] } });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events: ['post_tool_use'], generated: true, reason: null });
  });

  it.each([
    ['an empty list', []],
    ['null', null],
    ['a path Codex rejects for lacking ./', 'hooks/other.json'],
  ])("reports what Codex falls back to when the plugin's own declaration is %s", (_label, hooks) => {
    seed();
    writeJson('.codex-plugin/plugin.json', { ...MANIFEST, hooks });
    writeJson('hooks/other.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } });
    writeJson('hooks/hooks.json', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events: ['session_start'], generated: false, reason: null });
    expect(fs.existsSync(path.join(dir, GENERATED_CODEX_HOOKS))).toBe(false);
  });

  it.each([
    [
      'the template stops matching',
      () => template('".codex/skills/d/scripts/d" lint'),
      [],
      ".codex/hooks.json runs no command the plugin's Claude hooks run",
    ],
    [
      'the plugin starts delivering Codex hooks itself',
      () => writeJson('hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }),
      ['stop'],
      null,
    ],
  ])('retires its generated hooks once %s', (_label, change, events, reason) => {
    seed();
    ensureCodexPluginHooks(dir, false);
    change();

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events, generated: false, reason });
    expect(readJson('.codex-plugin/plugin.json')).toEqual(MANIFEST);
    expect(fs.existsSync(path.join(dir, GENERATED_CODEX_HOOKS))).toBe(false);
  });

  it('writes nothing when a container cannot be asked what it trusts', () => {
    seed();
    ensureCodexPluginHooks(dir, false);
    template('".codex/skills/d/scripts/d" lint');
    process.env.PATH = path.join(root, 'empty-path');

    expect(() => ensureCodexPluginHooks(dir, false)).toThrow();
    expect(readJson('.codex-plugin/plugin.json')).toEqual({ ...MANIFEST, hooks: `./${GENERATED_CODEX_HOOKS}` });
    expect(readJson(GENERATED_CODEX_HOOKS)).toEqual(GENERATED);
  });

  it('labels a dry run over an existing generation as the current state, and writes nothing', () => {
    seed();
    ensureCodexPluginHooks(dir, false);
    template('".codex/skills/d/scripts/d" lint');

    expect(ensureCodexPluginHooks(dir, true)).toEqual({
      events: ['post_tool_use'],
      generated: true,
      reason: 'dry run: current generation; a real run re-decides it',
    });
    expect(readJson(GENERATED_CODEX_HOOKS)).toEqual(GENERATED);
  });

  it('rebases from the Claude plugin directory the provider loads when the repo root has no Claude manifest', () => {
    seed();
    fs.rmSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.renameSync(path.join(dir, 'plugin'), path.join(dir, 'claude'));

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events: ['post_tool_use'], generated: true, reason: null });
    expect(JSON.stringify(readJson(GENERATED_CODEX_HOOKS))).toContain('${PLUGIN_ROOT}/claude/skills/d/scripts/d');
  });

  const INLINE = { PostToolUse: [{ hooks: [{ type: 'command', command: CLAUDE_CMD }] }] };
  it.each([
    // [label, manifest hooks, where the matching Claude hook lives, generated]
    ['a declared path merged with hooks/hooks.json', './extra.json', 'hooks/hooks.json', true],
    ['a declared path alone', './extra.json', 'extra.json', true],
    ['an inline event map', INLINE, 'inline', true],
    ['claude-codex-hooks.json, which Claude Code never loads', undefined, 'hooks/claude-codex-hooks.json', false],
  ])('reads the Claude hooks Claude Code runs for %s', (_label, hooks, matchingAt, generated) => {
    seed();
    const matching = readJson('plugin/hooks/hooks.json');
    fs.rmSync(path.join(dir, 'plugin/hooks/hooks.json'));
    writeJson('plugin/.claude-plugin/plugin.json', hooks === undefined ? { name: 'd' } : { name: 'd', hooks });
    if (hooks === './extra.json') writeJson('plugin/extra.json', { hooks: {} });
    if (matchingAt !== 'inline') writeJson(`plugin/${matchingAt}`, matching);

    expect(ensureCodexPluginHooks(dir, false).generated).toBe(generated);
  });

  it("reports a monorepo's sub-plugin hooks without generating any", () => {
    writeJson('.agents/plugins/marketplace.json', {
      name: 'mono',
      plugins: [{ name: 'x', source: { source: 'local', path: './plugins/x' } }],
    });
    writeJson('plugins/x/.codex-plugin/plugin.json', { name: 'x', skills: './skills/', hooks: './hooks/x.json' });
    writeJson('plugins/x/skills/s/SKILL.md', '');
    writeJson('plugins/x/hooks/x.json', { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } });

    expect(ensureCodexPluginHooks(dir, false)).toEqual({ events: ['post_tool_use'], generated: false, reason: null });
  });
});
