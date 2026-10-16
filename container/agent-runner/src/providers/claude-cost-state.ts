import fs from 'node:fs';

import type { CumulativeBaseline } from './types.js';

/** Read in bounded chunks: whatever size a resumable transcript reaches, the scan never holds it whole. */
const SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * A cost-state record is one small JSON object (a few KB even with many models). A longer line cannot be one, so
 * its bytes are dropped as they stream past instead of being held: an image or tool result can be one huge line.
 */
const MAX_COST_STATE_LINE_BYTES = 256 * 1024;
const COST_STATE_MARKER = '"cost-state"';

/** The CLI's cost-state schema bounds: a value outside them makes the CLI ignore the entry, so it is ignored here. */
const MAX_COUNTER = 1e15;
const MAX_TOTAL_COST_USD = 1e9;

const SESSION_FIELDS = [
  'totalAPIDuration',
  'totalAPIDurationWithoutRetries',
  'totalToolDuration',
  'totalLinesAdded',
  'totalLinesRemoved',
  'totalDuration',
  'startTime',
] as const;

const MODEL_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUSD',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCounter(value: unknown, max = MAX_COUNTER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function toBaselines(entry: Record<string, unknown>): Map<string, CumulativeBaseline> | null {
  if (!isCounter(entry.totalCostUSD, MAX_TOTAL_COST_USD)) return null;
  if (!SESSION_FIELDS.every((field) => isCounter(entry[field]))) return null;
  if (!isRecord(entry.modelUsage)) return null;
  const baselines = new Map<string, CumulativeBaseline>();
  for (const [model, usage] of Object.entries(entry.modelUsage)) {
    if (!model || /[\p{Cc}\p{Cf}]/u.test(model)) return null;
    if (!isRecord(usage) || !MODEL_FIELDS.every((field) => isCounter(usage[field]))) return null;
    if (usage.thinkingTokens !== undefined && !isCounter(usage.thinkingTokens)) return null;
    baselines.set(model, {
      inputTokens: usage.inputTokens as number,
      outputTokens: usage.outputTokens as number,
      cacheReadTokens: usage.cacheReadInputTokens as number,
      cacheWriteTokens: usage.cacheCreationInputTokens as number,
      costUsd: usage.costUSD as number,
    });
  }
  return baselines;
}

/** Calls `onLine` with each line short enough to be a cost-state record; longer lines are skipped unread. */
function forEachShortLine(transcriptPath: string, onLine: (line: string) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
    let parts: Buffer[] = [];
    let partBytes = 0;
    let overlong = false;
    const take = (bytes: Buffer): void => {
      if (overlong) return;
      if (partBytes + bytes.length > MAX_COST_STATE_LINE_BYTES) {
        overlong = true;
        parts = [];
        partBytes = 0;
        return;
      }
      parts.push(Buffer.from(bytes));
      partBytes += bytes.length;
    };
    const endLine = (): void => {
      // Decoded only once whole, so a multi-byte character split across chunks is never cut.
      if (!overlong && partBytes > 0) onLine(Buffer.concat(parts, partBytes).toString('utf-8'));
      parts = [];
      partBytes = 0;
      overlong = false;
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let start = 0;
      for (let nl = buf.indexOf(0x0a, start); nl !== -1 && nl < n; nl = buf.indexOf(0x0a, start)) {
        take(buf.subarray(start, nl));
        endLine();
        start = nl + 1;
      }
      take(buf.subarray(start, n));
    }
    endLine();
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The per-model running totals a resume of `sessionId` starts from. The CLI keeps the LAST valid `cost-state` entry
 * per session id and continues `modelUsage` from it, so a resumed query()'s first result already carries every
 * earlier turn. Null when the transcript is missing, unreadable or holds no valid entry for the session: the CLI then
 * starts from zero, and so does the caller.
 */
export function readResumedModelUsage(
  transcriptPath: string | null,
  sessionId: string,
): Map<string, CumulativeBaseline> | null {
  if (!transcriptPath) return null;
  let latest: Map<string, CumulativeBaseline> | null = null;
  const read = forEachShortLine(transcriptPath, (line) => {
    if (!line.includes(COST_STATE_MARKER)) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(entry) || entry.type !== 'cost-state' || entry.sessionId !== sessionId) return;
    latest = toBaselines(entry) ?? latest;
  });
  return read ? latest : null;
}
