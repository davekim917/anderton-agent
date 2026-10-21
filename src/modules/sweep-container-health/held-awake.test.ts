import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ gate: null as number | null | Error }));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  PREVIEW_ORIGIN_SUFFIX: 'preview.example.test',
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../bash-gate/index.js', () => ({
  openGateDeadlineMs: async () => {
    if (h.gate instanceof Error) throw h.gate;
    return h.gate;
  },
}));

import { closePreview, openPreview, PREVIEW_TTL_MS } from '../preview/service.js';
import { heldAwakeUntilMs } from './held-awake.js';

const SESSION = 'sess-held';
const openOne = () =>
  Date.parse(
    openPreview({ sessionId: SESSION, agentGroupId: 'ag-held', containerName: 'nanoclaw-v2-held-1', port: 5173 })
      .expiresAt,
  );

afterEach(() => {
  closePreview(SESSION);
  h.gate = null;
});

describe('heldAwakeUntilMs', () => {
  it('is null with no reason to hold the session', async () => {
    expect(await heldAwakeUntilMs(SESSION)).toBeNull();
  });

  it("holds until an open preview's expiry, 8 hours from open", async () => {
    const before = Date.now();
    const expiry = openOne();
    expect(expiry - before).toBeGreaterThanOrEqual(PREVIEW_TTL_MS);
    expect(await heldAwakeUntilMs(SESSION)).toBe(expiry);
  });

  it('takes the later of a gate deadline and a preview expiry', async () => {
    const expiry = openOne();
    h.gate = expiry + 1;
    expect(await heldAwakeUntilMs(SESSION)).toBe(expiry + 1);
    h.gate = expiry - 1;
    expect(await heldAwakeUntilMs(SESSION)).toBe(expiry);
  });

  it('a failed gate lookup still leaves the preview holding the session', async () => {
    const expiry = openOne();
    h.gate = new Error('db unavailable');
    expect(await heldAwakeUntilMs(SESSION)).toBe(expiry);
  });
});
