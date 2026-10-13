/**
 * Banned-pattern scan for the always-on instruction surface: point-in-time content, and a per-PR push cap
 * (round 3 is the agent's pr-review-loop checkpoint; a cap only yields an escalation). Kept out of
 * `fleet-drift.ts` so importing it does not load `better-sqlite3`. No byte ceilings: trimming to a number is no bar.
 */

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
  {
    name: 'push_cap',
    re: /\b(?:max(?:imum)?|at most|no more than|up to)\s+(?:\d+|one|two|three|four|five)\s+pushes\b|\b(?:\d+|one|two|three|four|five)[- ]push\s+(?:cap|limit|budget)\b/i,
  },
];

const TICKET_KEY = /^[A-Z][A-Z0-9_]*$/;

/** A tracker key is per install (`ticketKeys`, e.g. `ENG` for `ENG-123`): a built-in list would name someone's team. */
export function scanBannedPatterns(content: string, ticketKeys: readonly string[] = []): string[] {
  const hits = BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
  const keys = ticketKeys.filter((key) => TICKET_KEY.test(key));
  if (keys.length > 0 && new RegExp(`\\b(?:${keys.join('|')})-\\d+\\b`).test(content)) hits.push('ticket_ref');
  return hits;
}
