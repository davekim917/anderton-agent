import fs from 'fs';
import path from 'path';

/** Local `source` paths a repo's own marketplace lists below its root, normalized to POSIX relative form. */
export function marketplaceSubPlugins(repoPath: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(repoPath, '.claude-plugin', 'marketplace.json'), 'utf8'));
  } catch {
    return [];
  }
  const listed = (raw as { plugins?: unknown }).plugins;
  if (!Array.isArray(listed)) return [];
  const out = new Set<string>();
  for (const plugin of listed) {
    const source = (plugin as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') continue;
    const rel = path.relative(repoPath, path.resolve(repoPath, source));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.add(rel.split(path.sep).join('/'));
  }
  return [...out];
}
