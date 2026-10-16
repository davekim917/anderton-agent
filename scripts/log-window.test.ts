import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';
import { parseZonedInstant, scanLogWindow } from './log-window.js';

enforceHermeticity();

/**
 * scripts/log-window.ts over fixture log directories. Lines are written the way src/log.ts writes them: a
 * bracketed local stamp with a numeric offset (or, for pre-offset lines, none), an ANSI-coloured level, and
 * WARN and above in nanoclaw.error.log only.
 */

const dirs: string[] = [];
const C = (code: number, s: string) => `\x1b[${code}m${s}\x1b[39m`;
const line = (stamp: string, level: 'INFO' | 'WARN' | 'ERROR', msg: string) =>
  `[${stamp}] ${C(level === 'INFO' ? 32 : level === 'WARN' ? 33 : 31, level)} ${C(36, msg)}`;

function logsDir(files: Record<string, { lines: string[]; mtime?: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-window-'));
  dirs.push(dir);
  for (const [name, { lines, mtime }] of Object.entries(files)) {
    const p = path.join(dir, name);
    const text = `${lines.join('\n')}\n`;
    fs.writeFileSync(p, name.endsWith('.gz') ? zlib.gzipSync(text) : text);
    if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  }
  return dir;
}

const ms = (iso: string) => Date.parse(iso);

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('scanLogWindow', () => {
  it('places lines stamped in the host zone into a UTC window by their own offset', () => {
    const dir = logsDir({
      'nanoclaw.log': {
        lines: [
          line('2026-09-06 08:59:59.999-04:00', 'INFO', 'before the window'),
          line('2026-09-06 09:00:00.000-04:00', 'INFO', 'opens the window'),
          line('2026-09-06 09:30:00.000-04:00', 'INFO', 'inside the window'),
          line('2026-09-06 10:00:00.000-04:00', 'INFO', 'at the exclusive end'),
        ],
      },
    });
    const r = scanLogWindow({ logsDir: dir, sinceMs: ms('2026-09-06T13:00:00Z'), untilMs: ms('2026-09-06T14:00:00Z') });
    expect(r.inWindow).toBe(2);
    expect(r.records.map((t) => t.split(' ').slice(-3).join(' '))).toEqual(['opens the window', 'inside the window']);
    expect(r.unknown).toBe(0);
  });

  it('counts warnings that only nanoclaw.error.log holds, with their continuation lines', () => {
    const dir = logsDir({
      'nanoclaw.log': { lines: [line('2026-09-06 09:10:00.000-04:00', 'INFO', 'routine')] },
      'nanoclaw.error.log': {
        lines: [
          line('2026-09-06 09:20:00.000-04:00', 'WARN', 'Central lease wait exceeded 1 s'),
          line('2026-09-06 09:21:00.000-04:00', 'ERROR', 'delivery failed'),
          '    at deliverOne (delivery.js:10:5)',
        ],
      },
    });
    const r = scanLogWindow({
      logsDir: dir,
      sinceMs: ms('2026-09-06T13:00:00Z'),
      untilMs: ms('2026-09-06T14:00:00Z'),
      match: /deliverOne/,
    });
    expect(r.filesRead).toEqual(['nanoclaw.log', 'nanoclaw.error.log']);
    expect(r.byLevel).toEqual({ INFO: 1, WARN: 1, ERROR: 1 });
    expect(r.matching).toBe(1);
    expect(r.records).toEqual([
      '[2026-09-06 09:21:00.000-04:00] ERROR delivery failed\n    at deliverOne (delivery.js:10:5)',
    ]);
  });

  it('counts offset-less lines as unknown, never inside the window', () => {
    const dir = logsDir({
      'nanoclaw.error.log': {
        lines: [
          line('2026-09-11 09:05:00.000', 'ERROR', 'pre-offset line one'),
          line('2026-09-11 09:06:00.000', 'ERROR', 'pre-offset line two'),
          line('2026-09-11 09:07:00.000', 'ERROR', 'pre-offset line three'),
          line('2026-09-11 09:30:00.000-04:00', 'ERROR', 'new error'),
          line('2026-09-11 09:40:00.000-04:00', 'ERROR', 'another new error'),
        ],
      },
    });
    const r = scanLogWindow({
      logsDir: dir,
      sinceMs: ms('2026-09-11T13:00:00Z'),
      untilMs: ms('2026-09-11T14:00:00Z'),
      match: /error|line/,
    });
    expect(r.inWindow).toBe(2);
    expect(r.unknown).toBe(3);
    expect(r.unknownMatching).toBe(3);
    expect(r.records.every((t) => !t.includes('pre-offset'))).toBe(true);
  });

  it('reads rotated and compressed copies written after the window opened, and stops at the first older one', () => {
    const dir = logsDir({
      'nanoclaw.log': { lines: [line('2026-09-08 10:00:00.000-04:00', 'INFO', 'today')] },
      'nanoclaw.log.1': {
        lines: [line('2026-09-07 10:00:00.000-04:00', 'INFO', 'yesterday')],
        mtime: '2026-09-08T04:00:00Z',
      },
      'nanoclaw.log.2.gz': {
        lines: [line('2026-09-06 22:30:00.000-04:00', 'INFO', 'late on the 6th, in the window')],
        mtime: '2026-09-07T04:00:00Z',
      },
      'nanoclaw.log.3.gz': {
        lines: [line('2026-09-07 12:00:00.000-04:00', 'INFO', 'misplaced line that must not be read')],
        mtime: '2026-09-06T04:00:00Z',
      },
    });
    const r = scanLogWindow({ logsDir: dir, sinceMs: ms('2026-09-07T00:00:00Z'), untilMs: ms('2026-09-08T23:00:00Z') });
    expect(r.filesRead).toEqual(['nanoclaw.log', 'nanoclaw.log.1', 'nanoclaw.log.2.gz']);
    expect(r.inWindow).toBe(3);
  });
});

describe('parseZonedInstant', () => {
  it.each([
    ['2026-09-06T13:00:00Z', ms('2026-09-06T13:00:00Z')],
    ['2026-09-06T09:00:00-04:00', ms('2026-09-06T13:00:00Z')],
    ['2026-09-06T13:00Z', ms('2026-09-06T13:00:00Z')],
  ])('accepts %s', (value, expected) => {
    expect(parseZonedInstant('--since', value)).toBe(expected);
  });

  it.each(['2026-09-06 13:00', '2026-09-06T13:00:00', '2026-09-06', 'yesterday'])('refuses %s', (value) => {
    expect(() => parseZonedInstant('--since', value)).toThrow(/must be ISO-8601 with Z or a numeric offset/);
  });
});
