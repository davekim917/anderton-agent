/**
 * Verify skills that create-verification-skill writes into a workgroup's shared tree
 * (`<workgroup>/.claude/skills/verify-<project>/`). No provider runtime scans that directory for skills, so the
 * composed doc names each one by path. A promoted skill's directory holds a `PROMOTED` note instead of SKILL.md; the
 * skill lives in its project's repo. Siblings can write the tree, so only a directory name that passes
 * VERIFY_SKILL_NAME_RE reaches the always-on doc; a skill's description or body, or a PROMOTED note, never does.
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import {
  WORKGROUP_CONTAINER_PATH,
  workgroupSharedDir,
  workgroupSharedTreeMounted,
} from './modules/workgroup/shared-dirs.js';

const VERIFY_SKILL_NAME_RE = /^verify-[a-z0-9-]+$/;
const VERIFY_SKILLS_LISTED_MAX = 20;
const VERIFY_SKILLS_SCANNED_MAX = 200;

type VerifySkill = { name: string; promoted: boolean };

function isPlainDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional doc section must never block a spawn; unreadable means unlisted.
  } catch {
    return false;
  }
}

function isPlainFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional doc section must never block a spawn; unreadable means unlisted.
  } catch {
    return false;
  }
}

/**
 * Siblings can fill this directory, and the scan runs synchronously on the host's spawn path, so it reads at most
 * VERIFY_SKILLS_SCANNED_MAX entries and stats only names that already match.
 */
function scanVerifySkills(skillsDir: string): { skills: VerifySkill[]; truncated: boolean } {
  const skills: VerifySkill[] = [];
  const sorted = (): VerifySkill[] => skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  let dir: fs.Dir | undefined;
  let scanned = 0;
  try {
    dir = fs.opendirSync(skillsDir);
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++scanned > VERIFY_SKILLS_SCANNED_MAX) return { skills: sorted(), truncated: true };
      if (!VERIFY_SKILL_NAME_RE.test(entry.name) || !entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      if (isPlainFile(path.join(skillDir, 'SKILL.md'))) skills.push({ name: entry.name, promoted: false });
      else if (isPlainFile(path.join(skillDir, 'PROMOTED'))) skills.push({ name: entry.name, promoted: true });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional doc section must never block a spawn; unreadable means unlisted.
  } catch (err) {
    log.warn('Workgroup skills directory is unreadable; listing no verify skills', { skillsDir, err: String(err) });
    return { skills: [], truncated: false };
  } finally {
    dir?.closeSync();
  }
  return { skills: sorted(), truncated: false };
}

/** No shared-tree mount, no section: never advertise a path the container cannot read. */
export function workgroupVerifySkillsInstructions(workgroupId: string): string | null {
  if (!workgroupSharedTreeMounted(workgroupId)) return null;
  const skillsDir = path.join(workgroupSharedDir(workgroupId), '.claude', 'skills');
  if (!isPlainDir(skillsDir)) return null;
  const { skills, truncated } = scanVerifySkills(skillsDir);
  if (skills.length === 0) return null;

  const containerSkillsDir = `${WORKGROUP_CONTAINER_PATH}/.claude/skills`;
  const shown = skills.slice(0, VERIFY_SKILLS_LISTED_MAX);
  const lines = shown.map(({ name, promoted }) =>
    promoted
      ? `- \`${name}\`: promoted to its project's repo; in your worktree of it, read \`.claude/skills/${name}/SKILL.md\` (\`${containerSkillsDir}/${name}/PROMOTED\` names the repo)`
      : `- \`${name}\`: \`${containerSkillsDir}/${name}/SKILL.md\``,
  );
  const binding = shown.some((s) => s.promoted)
    ? "its binding names the checkout it covers; a promoted skill's binding still applies, so confirm your worktree matches it"
    : 'its binding names the checkout it covers';
  const more = skills.length - VERIFY_SKILLS_LISTED_MAX;
  if (truncated) lines.push(`- more not listed under \`${containerSkillsDir}/\``);
  else if (more > 0) lines.push(`- +${more} more under \`${containerSkillsDir}/\``);
  return [
    '## Workgroup verify skills',
    '',
    'This workgroup keeps verification skills in its shared folder. No runtime loads them, so read them by path:',
    '',
    ...lines,
    '',
    `Before claiming a change to one of these projects works, read that skill's SKILL.md (${binding}) and run its verification.`,
  ].join('\n');
}
