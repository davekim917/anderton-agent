import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { CommandCenter, HostSession } from '../../../../src/dashboard/command-center/types.js';
import { CommandCenterApp } from './CommandCenterApp.js';

const s = (session_id: string, status: HostSession['status'], since: string): HostSession => ({
  session_id,
  title: `title ${session_id}`,
  cwd: '~/nanoclaw-v2',
  status,
  since,
});

const payload: CommandCenter = {
  generated_at: '2026-10-12T16:00:00.000Z',
  live_sha: '771bb4cdbee9f7785f71e2a7859bab07cb51d2cd',
  prs_as_of: '2026-10-12T15:59:00.000Z',
  gate_bypass_prs: [],
  timezone: 'Asia/Tokyo',
  sessions: [
    s('idle-1', 'idle', '2026-10-12T15:00:00Z'),
    s('wait-old', 'needs_you', '2026-10-12T12:00:00Z'),
    s('busy-1', 'working', '2026-10-12T15:50:00Z'),
    s('wait-new', 'needs_you', '2026-10-12T15:53:00Z'),
  ],
  prs: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(data: CommandCenter) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })),
  );
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CommandCenterApp />
    </SWRConfig>,
  );
}

describe('CommandCenterApp', () => {
  it('renders the session tiles in urgency order, stamped in the install timezone', async () => {
    const { container } = show(payload);
    await screen.findByText('title wait-new');
    const order = Array.from(container.querySelectorAll('[data-session]')).map((el) => el.getAttribute('data-session'));
    expect(order).toEqual(['wait-new', 'wait-old', 'busy-1', 'idle-1']);
    expect(screen.getAllByText(/Oct 13, 2026, 1:00/)).not.toHaveLength(0);
  });

  it('counts every open gate bypass, not only the PRs listed in the window', async () => {
    const { container } = show({ ...payload, gate_bypass_prs: [3, 7, 12] });
    await screen.findByText('title wait-new');
    const total = container.querySelector('.cc-totals .cc-total:last-child');
    expect(total?.textContent).toBe('3merged past the gate');
  });

  it.each([
    ['never fetched', null, /PRs unavailable/, /No PRs to show|PRs as of/],
    ['fresh and empty', '2026-10-12T15:59:00.000Z', /No PRs to show/, /PRs unavailable|PRs as of/],
    ['stale', '2026-10-12T15:40:00.000Z', /PRs as of 20m ago/, /PRs unavailable/],
  ])('PR rows %s', async (_label, prs_as_of, shown, absent) => {
    const { container } = show({ ...payload, prs_as_of });
    await screen.findByText('title wait-new');
    expect(container.textContent).toMatch(shown);
    expect(container.textContent).not.toMatch(absent);
  });
});
