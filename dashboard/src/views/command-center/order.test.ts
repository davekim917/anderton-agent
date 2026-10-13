import { describe, expect, it } from 'vitest';

import type { HostSession } from '../../../../src/dashboard/command-center/types.js';
import { orderSessions } from './order.js';

const s = (session_id: string, status: HostSession['status'], since: string): HostSession => ({
  session_id,
  title: session_id,
  cwd: '~',
  status,
  since,
});

describe('orderSessions', () => {
  it('orders by needs_you, working, unknown, shell, idle, then most recent first', () => {
    const ordered = orderSessions([
      s('idle-old', 'idle', '2026-10-12T08:00:00Z'),
      s('shell', 'shell', '2026-10-12T15:00:00Z'),
      s('wait-old', 'needs_you', '2026-10-12T09:00:00Z'),
      s('unknown', 'unknown', '2026-10-12T15:00:00Z'),
      s('busy', 'working', '2026-10-12T10:00:00Z'),
      s('idle-new', 'idle', '2026-10-12T14:00:00Z'),
      s('wait-new', 'needs_you', '2026-10-12T14:59:00Z'),
    ]);
    expect(ordered.map((x) => x.session_id)).toEqual([
      'wait-new',
      'wait-old',
      'busy',
      'unknown',
      'shell',
      'idle-new',
      'idle-old',
    ]);
  });
});
