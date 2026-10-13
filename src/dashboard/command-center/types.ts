/** Wire contract for `GET /dashboard/api/command-center`; the dashboard imports these types directly. */
export type HostSessionStatus = 'needs_you' | 'working' | 'idle' | 'shell' | 'unknown';

export interface HostSession {
  session_id: string;
  title: string;
  /** Home-relative, e.g. `~/nanoclaw-v2`. */
  cwd: string;
  status: HostSessionStatus;
  /** ISO UTC. */
  since: string;
}

type PrStage = 'open' | 'merged' | 'deployed';

export interface PrRow {
  number: number;
  title: string;
  url: string;
  stage: PrStage;
  unreviewed: boolean;
  updated_at: string;
}

export interface CommandCenter {
  generated_at: string;
  sessions: HostSession[];
  prs: PrRow[];
  live_sha: string | null;
  /** When the served PR rows were fetched (ISO UTC); null when no fetch has succeeded since boot. */
  prs_as_of: string | null;
  /** Every PR with an open gate-bypass issue, inside the 7-day window or not. */
  gate_bypass_prs: number[];
  /** The install timezone (IANA); the page renders times in it, not the browser's zone. */
  timezone: string;
}
