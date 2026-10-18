/**
 * Verify skills that create-verification-skill writes into a workgroup's shared tree
 * (`<workgroup>/.claude/skills/verify-<project>/`). No provider runtime scans that directory for skills, so the
 * composed doc names each one by path. Siblings can write the tree, so only a directory name that passes
 * VERIFY_SKILL_NAME_RE reaches the always-on doc; a skill's own description or body never does.
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
function scanVerifySkills(skillsDir: string): { names: string[]; truncated: boolean } {
  const names: string[] = [];
  let dir: fs.Dir | undefined;
  let scanned = 0;
  try {
    dir = fs.opendirSync(skillsDir);
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++scanned > VERIFY_SKILLS_SCANNED_MAX) return { names: names.sort(), truncated: true };
      if (
        VERIFY_SKILL_NAME_RE.test(entry.name) &&
        entry.isDirectory() &&
        isPlainFile(path.join(skillsDir, entry.name, 'SKILL.md'))
      )
        names.push(entry.name);
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional doc section must never block a spawn; unreadable means unlisted.
  } catch (err) {
    log.warn('Workgroup skills directory is unreadable; listing no verify skills', { skillsDir, err: String(err) });
    return { names: [], truncated: false };
  } finally {
    dir?.closeSync();
  }
  return { names: names.sort(), truncated: false };
}

/** No shared-tree mount, no section: never advertise a path the container cannot read. */
export function workgroupVerifySkillsInstructions(workgroupId: string): string | null {
  if (!workgroupSharedTreeMounted(workgroupId)) return null;
  const skillsDir = path.join(workgroupSharedDir(workgroupId), '.claude', 'skills');
  if (!isPlainDir(skillsDir)) return null;
  const { names, truncated } = scanVerifySkills(skillsDir);
  if (names.length === 0) return null;

  const containerSkillsDir = `${WORKGROUP_CONTAINER_PATH}/.claude/skills`;
  const lines = names
    .slice(0, VERIFY_SKILLS_LISTED_MAX)
    .map((name) => `- \`${name}\`: \`${containerSkillsDir}/${name}/SKILL.md\``);
  const more = names.length - VERIFY_SKILLS_LISTED_MAX;
  if (truncated) lines.push(`- more not listed under \`${containerSkillsDir}/\``);
  else if (more > 0) lines.push(`- +${more} more under \`${containerSkillsDir}/\``);
  return [
    '## Workgroup verify skills',
    '',
    'This workgroup keeps verification skills in its shared folder. No runtime loads them, so read them by path:',
    '',
    ...lines,
    '',
    "Before claiming a change to one of these projects works, read that skill's SKILL.md (its binding names the checkout it covers) and run its verification.",
  ].join('\n');
}
