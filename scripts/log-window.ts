#!/usr/bin/env -S pnpm exec tsx
/**
 * What the host logged in a UTC window, from both log files.
 *
 *   pnpm exec tsx scripts/log-window.ts --since <ISO> [--until <ISO>] [--match <regex>] [--lines] [--json] [--logs <dir>]
 *
 * Both instants must carry `Z` or a numeric offset. Lines are placed by their own offset through `parseLogStamp`,
 * so the host's zone and the reader's never matter. WARN and above go to `nanoclaw.error.log` and the rest to
 * `nanoclaw.log`, so both are read, plus every rotated copy the window reaches. A line with no offset has no
 * recoverable instant: it is counted as unknown, never in or out of the window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { LOG_STAMP_RE, parseLogStamp } from '../src/log.js';

const LOG_BASES = ['nanoclaw.log', 'nanoclaw.error.log'] as const;
// eslint-disable-next-line no-control-regex -- deliberately matches the ANSI CSI escape byte to strip src/log.ts's color codes
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LEVEL_RE = /^\[[^\]]+\]\s+([A-Z]+)\b/;

export interface WindowOptions {
  logsDir: string;
  sinceMs: number;
  untilMs: number;
  match?: RegExp;
}

export interface WindowResult {
  since: string;
  until: string;
  filesRead: string[];
  inWindow: number;
  byLevel: Record<string, number>;
  matching: number | null;
  unknown: number;
  unknownMatching: number | null;
  records: string[];
}

function readLines(file: string): string[] {
  const raw = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return text.split('\n');
}

/** Live file first, then `.1`, `.2.gz`, … up to the last copy written after the window opened. */
function filesReaching(logsDir: string, base: string, sinceMs: number): string[] {
  const out: string[] = [];
  for (let n = 0; ; n++) {
    const candidates = n === 0 ? [base] : [`${base}.${n}`, `${base}.${n}.gz`];
    const found = candidates.map((c) => path.join(logsDir, c)).find((p) => fs.existsSync(p));
    if (!found || (n > 0 && fs.statSync(found).mtimeMs < sinceMs)) break;
    out.push(found);
  }
  return out;
}

type Placement = 'in' | 'out' | 'unknown';

export function scanLogWindow(opts: WindowOptions): WindowResult {
  const result: WindowResult = {
    since: new Date(opts.sinceMs).toISOString(),
    until: new Date(opts.untilMs).toISOString(),
    filesRead: [],
    inWindow: 0,
    byLevel: {},
    matching: opts.match ? 0 : null,
    unknown: 0,
    unknownMatching: opts.match ? 0 : null,
    records: [],
  };

  const settle = (placement: Placement, record: string[]) => {
    if (record.length === 0 || placement === 'out') return;
    const text = record.join('\n');
    const hit = opts.match ? opts.match.test(text) : true;
    if (placement === 'unknown') {
      result.unknown++;
      if (hit && result.unknownMatching !== null) result.unknownMatching++;
      return;
    }
    result.inWindow++;
    const level = LEVEL_RE.exec(record[0])?.[1] ?? 'UNLEVELLED';
    result.byLevel[level] = (result.byLevel[level] ?? 0) + 1;
    if (!hit) return;
    if (result.matching !== null) result.matching++;
    result.records.push(text);
  };

  for (const base of LOG_BASES) {
    for (const file of filesReaching(opts.logsDir, base, opts.sinceMs)) {
      result.filesRead.push(path.basename(file));
      let placement: Placement = 'unknown';
      let record: string[] = [];
      for (const raw of readLines(file)) {
        const line = raw.replace(ANSI_RE, '');
        const m = LOG_STAMP_RE.exec(line);
        if (!m) {
          if (line !== '') record.push(line);
          continue;
        }
        settle(placement, record);
        record = [line];
        const parsed = parseLogStamp(m[1], m[2]);
        if (!parsed || !parsed.exact) placement = 'unknown';
        else placement = parsed.ms >= opts.sinceMs && parsed.ms < opts.untilMs ? 'in' : 'out';
      }
      settle(placement, record);
    }
  }
  return result;
}

class InstantError extends Error {}

const ZONED_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch ms of an instant that names its zone; a naive wall-clock time is the misread this tool exists to prevent. */
export function parseZonedInstant(flag: string, value: string): number {
  if (!ZONED_ISO_RE.test(value)) {
    throw new InstantError(
      `${flag} must be ISO-8601 with Z or a numeric offset (e.g. 2026-09-06T13:00:00Z), got '${value}'`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new InstantError(`${flag} is not a valid instant: '${value}'`);
  return ms;
}

function render(r: WindowResult, match: RegExp | undefined, lines: boolean): string {
  const levels = Object.entries(r.byLevel)
    .sort(([, a], [, b]) => b - a)
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
  const out = [
    `window ${r.since} .. ${r.until} (UTC)`,
    `read: ${r.filesRead.join(', ') || '(no log files found)'}`,
    `in window: ${r.inWindow} record(s)${levels ? ` (${levels})` : ''}`,
  ];
  if (match) out.push(`matching ${match}: ${r.matching}`);
  if (r.unknown > 0) {
    const of = match ? `, ${r.unknownMatching} matching` : '';
    out.push(
      `unknown: ${r.unknown} record(s) with no UTC offset${of}; their instant cannot be recovered, so they are counted neither in nor out`,
    );
  }
  if (lines && r.records.length) out.push('', ...r.records);
  return out.join('\n');
}

function main(argv: string[]): number {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lines' || a === '--json') flags.add(a);
    else if (['--since', '--until', '--match', '--logs'].includes(a) && i + 1 < argv.length) args.set(a, argv[++i]);
    else {
      console.error(`log-window: unknown or incomplete argument '${a}'`);
      return 2;
    }
  }
  const since = args.get('--since');
  if (!since) {
    console.error('log-window: --since <ISO with Z or offset> is required');
    return 2;
  }
  let sinceMs: number;
  let untilMs: number;
  try {
    sinceMs = parseZonedInstant('--since', since);
    untilMs = args.has('--until') ? parseZonedInstant('--until', args.get('--until')!) : Date.now();
  } catch (err) {
    if (!(err instanceof InstantError)) throw err;
    console.error(`log-window: ${err.message}`);
    return 2;
  }
  const match = args.has('--match') ? new RegExp(args.get('--match')!) : undefined;
  const logsDir = args.get('--logs') ?? path.join(process.cwd(), 'logs');
  const result = scanLogWindow({ logsDir, sinceMs, untilMs, match });
  console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : render(result, match, flags.has('--lines')));
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
