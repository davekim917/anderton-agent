import type { HostSession, HostSessionStatus } from '../../../../src/dashboard/command-center/types.js';

export const STATUS_ORDER: readonly HostSessionStatus[] = ['needs_you', 'working', 'unknown', 'shell', 'idle'];

export function orderSessions(sessions: readonly HostSession[]): HostSession[] {
  return [...sessions].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || Date.parse(b.since) - Date.parse(a.since),
  );
}
