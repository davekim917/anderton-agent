import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type HookMap = Record<string, unknown[]>;

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface CodexHookDelivery {
  events: string[];
  generated: boolean;
  /** Why Codex runs none of the plugin's hooks; null when it runs some. */
  reason: string | null;
}

export const GENERATED_CODEX_HOOKS = '.codex-plugin/nanoclaw-codex-hooks.json';
const AGENT_RUNNER_DIR = fileURLToPath(new URL('../container/agent-runner/', import.meta.url));

interface ContainerView {
  /** Per plugin the repo registers with Codex: the hook events a container would trust (`post_tool_use`). */
  codex: { dir: string; events: string[] }[];
  /** The repo's directories the Claude provider loads as plugins. */
  claudeDirs: string[];
}

/**
 * What a container makes of `repo` under `pluginsRoot`, from the agent-runner's own code in its Bun tree: Codex
 * trust as `pluginHookTrustEntries` computes it (`planCodexPluginRegistration` + `collectPluginHookTrustEntries`),
 * and Claude's plugin directories from `discoverPlugins`.
 */
function containerView(pluginsRoot: string, repo: string): ContainerView {
  const out = execFileSync(
    'bun',
    [
      '-e',
      "import { planCodexPluginRegistration } from './src/codex-companion-setup.ts';" +
        "import { collectPluginHookTrustEntries } from './src/providers/codex-hook-trust.ts';" +
        "import { discoverPlugins } from './src/providers/claude.ts';" +
        "import path from 'path';" +
        'const { ROOT, REPO } = process.env;' +
        'const repoDir = path.join(ROOT, REPO);' +
        'const codex = planCodexPluginRegistration(ROOT)' +
        ".filter((p) => p.repoName === REPO && p.action === 'register' && p.pluginDir && p.entryName && p.marketplaceName)" +
        '.map((p) => ({ dir: p.pluginDir, events: [...new Set(collectPluginHookTrustEntries({' +
        "pluginId: `${p.entryName}@${p.marketplaceName}`, dir: p.pluginDir }).map((e) => e.key.split(':').at(-3)))] }));" +
        'const claudeDirs = discoverPlugins(ROOT, { topLevel: new Set(), subPaths: new Set() }).plugins' +
        '.map((p) => p.path).filter((p) => p === repoDir || p.startsWith(repoDir + path.sep));' +
        'console.log(JSON.stringify({ codex, claudeDirs }));',
    ],
    { cwd: AGENT_RUNNER_DIR, encoding: 'utf-8', env: { ...process.env, ROOT: pluginsRoot, REPO: repo } },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as ContainerView;
}

const eventsOf = (plugins: { events: string[] }[]): string[] => [...new Set(plugins.flatMap((p) => p.events))];

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function hooksOf(file: string): HookMap | null {
  const hooks = (readJson(file) as { hooks?: unknown } | null)?.hooks;
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? (hooks as HookMap) : null;
}

/**
 * The hooks Claude Code runs for a plugin directory: `hooks/hooks.json` merged with every manifest `hooks` entry, a
 * `./` path to a wrapped hooks file or an inline event map, alone or in an array (code.claude.com plugins reference).
 */
function claudePluginHooks(pluginDir: string): HookMap {
  const merged: HookMap = {};
  const add = (hooks: HookMap | null) => {
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      if (Array.isArray(groups)) (merged[event] ??= []).push(...groups);
    }
  };
  add(hooksOf(path.join(pluginDir, 'hooks', 'hooks.json')));
  const declared = (readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json')) as { hooks?: unknown } | null)
    ?.hooks;
  for (const entry of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (typeof entry === 'string') {
      if (entry.startsWith('./')) add(hooksOf(path.resolve(pluginDir, entry)));
    } else if (entry && typeof entry === 'object') {
      add(entry as HookMap);
    }
  }
  return merged;
}

/** `<executable basename> <args>` of the last command a hook line runs, so two install layouts compare equal. */
function invocation(command: string): string {
  const last = command.split(/\|\||&&|;/).pop() ?? '';
  const tokens = last.trim().replace(/["']/g, '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return [path.basename(tokens[0]!), ...tokens.slice(1)].join(' ');
}

function isTrackedByGit(repoDir: string, rel: string): boolean | null {
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  try {
    execFileSync('git', ['-C', repoDir, 'ls-files', '--error-unmatch', rel], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Codex runs a registered plugin's hooks only from its `.codex-plugin/plugin.json` `hooks` field or the conventional
 * fallback, so hooks a plugin ships only as a per-project template (`.codex/hooks.json`, paths relative to the target
 * project) reach no container. Generating beside hooks a container already trusts could shadow or double them, so
 * generation happens only when it trusts none of the plugin's own.
 */
export function ensureCodexPluginHooks(dir: string, dryRun: boolean): CodexHookDelivery {
  const view = () => containerView(path.dirname(dir), path.basename(dir));
  const initial = view();
  const before = initial.codex;
  const trusted = () => view().codex;
  const manifestPath = path.join(dir, '.codex-plugin', 'plugin.json');
  const manifest = readJson(manifestPath) as Record<string, unknown> | null;
  const { hooks: declared, ...withoutHooks } = manifest ?? {};
  if (!manifest || (declared !== undefined && declared !== `./${GENERATED_CODEX_HOOKS}`)) {
    const events = eventsOf(before);
    const reason = manifest ? 'manifest hooks load no Codex events' : 'no Codex manifest at the repo root';
    return { events, generated: false, reason: events.length ? null : reason };
  }
  const own = declared !== undefined;
  const generated = rebaseTemplateHooks(dir, initial.claudeDirs);
  const noMatch = fs.existsSync(path.join(dir, '.codex', 'hooks.json'))
    ? ".codex/hooks.json runs no command the plugin's Claude hooks run"
    : 'plugin declares no Codex hooks';
  const untouchable = (): string | null => {
    if (own) return null;
    const tracked = isTrackedByGit(dir, '.codex-plugin/plugin.json');
    if (tracked === false) return null;
    return tracked
      ? 'plugin ships its own Codex manifest without hooks'
      : 'not a git checkout, so the Codex manifest may be the plugin’s own; left untouched';
  };

  if (dryRun) {
    if (own) return { events: eventsOf(before), generated: true, reason: 'dry run: current generation; a real run re-decides it' };
    if (eventsOf(before).length) return { events: eventsOf(before), generated: false, reason: null };
    if (Object.keys(generated).length === 0) return { events: [], generated: false, reason: noMatch };
    const blocked = untouchable();
    if (blocked) return { events: [], generated: false, reason: blocked };
    return { events: Object.keys(generated), generated: true, reason: 'dry run: predicted' };
  }

  const generatedPath = path.join(dir, GENERATED_CODEX_HOOKS);
  const originalManifest = fs.readFileSync(manifestPath, 'utf-8');
  const originalGenerated = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, 'utf-8') : null;
  const retire = () => {
    fs.writeFileSync(manifestPath, JSON.stringify(withoutHooks, null, 2) + '\n');
    fs.rmSync(generatedPath, { force: true });
  };
  try {
    if (own) retire();
    const pluginOwn = own ? trusted() : before;
    if (eventsOf(pluginOwn).length) return { events: eventsOf(pluginOwn), generated: false, reason: null };
    if (Object.keys(generated).length === 0) return { events: [], generated: false, reason: noMatch };
    const blocked = untouchable();
    if (blocked) return { events: [], generated: false, reason: blocked };
    fs.writeFileSync(generatedPath, JSON.stringify({ hooks: generated }, null, 2) + '\n');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...withoutHooks, hooks: `./${GENERATED_CODEX_HOOKS}` }, null, 2) + '\n');
    const after = eventsOf(trusted());
    if (after.length) return { events: after, generated: true, reason: null };
    retire();
    return { events: [], generated: false, reason: 'a container would trust none of the generated hooks' };
  } catch (err) {
    fs.writeFileSync(manifestPath, originalManifest);
    if (originalGenerated === null) fs.rmSync(generatedPath, { force: true });
    else fs.writeFileSync(generatedPath, originalGenerated);
    throw err;
  }
}

function rebaseTemplateHooks(dir: string, claudeDirs: string[]): HookMap {
  const template = hooksOf(path.join(dir, '.codex', 'hooks.json'));
  const generated: HookMap = {};
  if (!template) return generated;
  for (const pluginDir of claudeDirs) {
    const rel = path.relative(dir, pluginDir).split(path.sep).join('/');
    const claude = claudePluginHooks(pluginDir);
    const root = rel ? `\${PLUGIN_ROOT}/${rel}` : '${PLUGIN_ROOT}';
    for (const [event, groups] of Object.entries(template)) {
      const sources = ((claude[event] ?? []) as HookGroup[]).flatMap((g) => g.hooks ?? []);
      for (const group of groups as HookGroup[]) {
        const hooks = (group.hooks ?? []).flatMap((hook) => {
          if (typeof hook.command !== 'string') return [];
          const match = sources.find(
            (s) => typeof s.command === 'string' && invocation(s.command) === invocation(hook.command!),
          );
          if (!match) return [];
          const { commandWindows: _windows, ...rest } = hook;
          return [{ ...rest, command: match.command!.split('${CLAUDE_PLUGIN_ROOT}').join(root) }];
        });
        if (hooks.length) (generated[event] ??= []).push({ ...group, hooks });
      }
    }
  }
  return generated;
}
