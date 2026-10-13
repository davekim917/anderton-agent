/**
 * The container's own read of `excludePlugins`, deliberately NOT via `config.ts`: `loadConfig` falls back to
 * defaults on a read failure, which here would mean "nothing excluded" and deliver withheld plugins. A read
 * that cannot answer throws, and nothing catches it. The group's own list comes from container.json, its
 * workgroup's from the spawn env; the answer is their union.
 */
import fs from 'fs';

import {
  effectiveExcludePlugins,
  splitExcludedPlugins,
  validateExcludePlugins,
  WORKGROUP_EXCLUDE_PLUGINS_ENV,
  type ExcludedPlugins,
} from './plugin-exclusions.js';

const CONTAINER_CONFIG_PATH = '/workspace/agent/container.json';

function log(msg: string): void {
  console.error(`[excluded-plugins] ${msg}`);
}

let cached: ExcludedPlugins | null = null;

/** Unset means the workgroup opts out of nothing; a value that does not read as a valid list throws. */
function parseWorkgroupExcludePlugins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${WORKGROUP_EXCLUDE_PLUGINS_ENV} is not valid JSON — refusing to treat that as "nothing excluded": ${detail}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${WORKGROUP_EXCLUDE_PLUGINS_ENV} must be a JSON array — refusing to treat that as "nothing excluded"`,
    );
  }
  return validateExcludePlugins(parsed) ?? [];
}

/**
 * Applies the host's own validator. A non-object root (array, number, null) throws instead of reading as
 * "nothing declared": `[{"excludePlugins": [...]}]` would otherwise fail open.
 */
export function parseExcludedPlugins(raw: string, workgroupExcludes: readonly string[] = []): ExcludedPlugins {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(
      `container.json did not parse to a JSON object (got ${shape}) — refusing to read that as "nothing excluded"`,
    );
  }
  return splitExcludedPlugins(
    effectiveExcludePlugins(
      workgroupExcludes,
      validateExcludePlugins((parsed as { excludePlugins?: unknown }).excludePlugins),
    ),
  );
}

/**
 * ENOENT, and only ENOENT, means the group declares no exclusions; every other failure throws, since it might have
 * carried one.
 */
export function loadExcludedPlugins(
  configPath = CONTAINER_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): ExcludedPlugins {
  if (cached && configPath === CONTAINER_CONFIG_PATH) return cached;
  const workgroupExcludes = parseWorkgroupExcludePlugins(env[WORKGROUP_EXCLUDE_PLUGINS_ENV]);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const workgroupOnly = splitExcludedPlugins(workgroupExcludes);
      if (configPath === CONTAINER_CONFIG_PATH) cached = workgroupOnly;
      return workgroupOnly;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not read ${configPath} to apply excludePlugins — refusing to treat that as "nothing excluded": ${detail}`,
    );
  }
  const split = parseExcludedPlugins(raw, workgroupExcludes);
  if (split.topLevel.size || split.subPaths.size) {
    log(
      `excludePlugins: ${[...split.topLevel, ...split.subPaths].sort().join(', ')} ` +
        `(read from ${configPath} and ${WORKGROUP_EXCLUDE_PLUGINS_ENV}; applied by every plugin walker in this container)`,
    );
  }
  if (configPath === CONTAINER_CONFIG_PATH) cached = split;
  return split;
}

/** Reset the memo — tests only. */
export function _resetExcludedPlugins(): void {
  cached = null;
}
