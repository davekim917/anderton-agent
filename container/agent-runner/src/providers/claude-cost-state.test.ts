import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readResumedModelUsage } from './claude-cost-state.js';

const SESSION = '3f6a9b2c-1d4e-4f70-8a2b-5c6d7e8f9a01';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function costState(overrides: Record<string, unknown> = {}, model: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'cost-state',
    sessionId: SESSION,
    totalCostUSD: 12.5,
    totalAPIDuration: 10,
    totalAPIDurationWithoutRetries: 10,
    totalToolDuration: 5,
    totalLinesAdded: 3,
    totalLinesRemoved: 1,
    totalDuration: 20,
    startTime: 1_700_000_000_000,
    modelUsage: {
      'claude-opus-5[1m]': {
        inputTokens: 700,
        outputTokens: 2_000,
        thinkingTokens: 500,
        cacheReadInputTokens: 3_000_000,
        cacheCreationInputTokens: 40_000,
        webSearchRequests: 0,
        costUSD: 12.5,
        ...model,
      },
    },
    ...overrides,
  });
}

function transcript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-state-'));
  dirs.push(dir);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('readResumedModelUsage', () => {
  it('maps the saved per-model totals onto the turn_usage fields', () => {
    const file = transcript([JSON.stringify({ type: 'user', uuid: 'a' }), costState()]);
    expect(readResumedModelUsage(file, SESSION)).toEqual(
      new Map([
        [
          'claude-opus-5[1m]',
          { inputTokens: 700, outputTokens: 2_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 40_000, costUsd: 12.5 },
        ],
      ]),
    );
  });

  it('keeps the LAST valid entry for the session, even when it is lower than an earlier one', () => {
    const file = transcript([costState({}, { costUSD: 30 }), costState({}, { costUSD: 9 })]);
    expect(readResumedModelUsage(file, SESSION)?.get('claude-opus-5[1m]')?.costUsd).toBe(9);
  });

  it('skips an invalid later entry, as the CLI does, and keeps the last valid one', () => {
    const file = transcript([
      costState({}, { costUSD: 7 }),
      costState({}, { cacheReadInputTokens: -1 }),
      costState({ totalCostUSD: 'n/a' }),
      costState({ modelUsage: { 'bad\u0007model': {} } }),
      '{"type":"cost-state", truncated',
    ]);
    expect(readResumedModelUsage(file, SESSION)?.get('claude-opus-5[1m]')?.costUsd).toBe(7);
  });

  it('ignores another session`s entry', () => {
    const file = transcript([costState({ sessionId: 'b1c2d3e4-0000-4000-8000-000000000000' })]);
    expect(readResumedModelUsage(file, SESSION)).toBeNull();
  });

  it('returns null for a transcript with no saved totals, a missing file, or no path', () => {
    expect(readResumedModelUsage(transcript([JSON.stringify({ type: 'user', uuid: 'a' })]), SESSION)).toBeNull();
    expect(readResumedModelUsage('/nonexistent/cost-state.jsonl', SESSION)).toBeNull();
    expect(readResumedModelUsage(null, SESSION)).toBeNull();
  });

  it('reads an entry whose multi-byte character straddles a read-chunk boundary', () => {
    const model = `claude-${'\u20ac'.repeat(8)}`;
    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      webSearchRequests: 0,
      costUSD: 4.25,
    };
    const entry = costState({ modelUsage: { [model]: usage } });
    // Pad the first line so the 1 MiB chunk boundary falls one byte into the key's first 3-byte character.
    const keyByte = Buffer.byteLength(entry.slice(0, entry.indexOf('\u20ac')));
    const prefix = '{"type":"user","uuid":"a","text":"';
    const pad = 1024 * 1024 - (keyByte + 1) - 1 - prefix.length - 2;
    const file = transcript([`${prefix}${'x'.repeat(pad)}"}`, entry]);
    expect(readResumedModelUsage(file, SESSION)?.get(model)?.costUsd).toBe(4.25);
  });

  it('skips a record far longer than any cost-state and still finds the entry after it', () => {
    const huge = JSON.stringify({ type: 'user', uuid: 'a', image: 'A'.repeat(3 * 1024 * 1024) });
    const file = transcript([costState({}, { costUSD: 1 }), huge, costState({}, { costUSD: 2.5 }), huge]);
    expect(readResumedModelUsage(file, SESSION)?.get('claude-opus-5[1m]')?.costUsd).toBe(2.5);
  });

  it('accepts an entry without the optional thinkingTokens', () => {
    const file = transcript([costState({}, { thinkingTokens: undefined })]);
    expect(readResumedModelUsage(file, SESSION)?.get('claude-opus-5[1m]')?.inputTokens).toBe(700);
  });
});
