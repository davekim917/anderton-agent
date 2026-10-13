import { useState } from 'react';
import useSWR from 'swr';

import type {
  CommandCenter,
  HostSession,
  HostSessionStatus,
  PrRow,
} from '../../../../src/dashboard/command-center/types.js';
import { relAge } from '../../lib/derive.js';
import { signalStamp } from '../signal/source-display.js';
import { STATUS_ORDER, orderSessions } from './order.js';

const ENDPOINT = '/dashboard/api/command-center';
const REFRESH_MS = 15_000;
/** The host refetches PRs every minute; rows older than this mean GitHub reads are failing. */
const PRS_STALE_MS = 5 * 60_000;

class CommandCenterError extends Error {
  constructor(public status: number) {
    super(`Request failed (${status})`);
  }
}

async function fetchCommandCenter(): Promise<CommandCenter> {
  const res = await fetch(ENDPOINT, { credentials: 'include' });
  if (!res.ok) throw new CommandCenterError(res.status);
  return res.json() as Promise<CommandCenter>;
}

const GROUP_TITLE: Record<HostSessionStatus, string> = {
  needs_you: 'Your turn',
  working: 'Working',
  unknown: 'Status unknown',
  shell: 'In a shell',
  idle: 'Idle',
};

/** Collapsed behind a toggle on a phone, where the list is one long column. */
const QUIET: ReadonlySet<HostSessionStatus> = new Set(['shell', 'idle']);

function sessionLine(s: HostSession, now: number): string {
  const age = relAge(s.since, now);
  switch (s.status) {
    case 'needs_you':
      return `Your move · waiting ${age}`;
    case 'working':
      return `Working · ${age}`;
    case 'shell':
      return `In a shell · ${age}`;
    case 'idle':
      return `Idle ${age}`;
    case 'unknown':
      return `Status unknown · ${age}`;
  }
}

const STAGES: readonly PrRow['stage'][] = ['open', 'merged', 'deployed'];
const STAGE_LABEL: Record<PrRow['stage'], string> = { open: 'Open', merged: 'Merged · not live', deployed: 'Live' };

const isProblem = (p: PrRow) => p.unreviewed || p.stage !== 'deployed';

function PrSteps({ pr }: { pr: PrRow }) {
  const at = STAGES.indexOf(pr.stage);
  return (
    <span className="cc-steps" role="img" aria-label={`Stage: ${STAGE_LABEL[pr.stage]}`}>
      {STAGES.map((stage, i) => (
        <span key={stage} className={`cc-step ${i < at || pr.stage === 'deployed' ? 'done' : i === at ? 'cur' : ''}`}>
          <i />
          <b />
        </span>
      ))}
    </span>
  );
}

function PrList({ prs }: { prs: PrRow[] }) {
  return (
    <>
      {prs.map((p) => (
        <div key={p.number} className={`cc-pr${p.unreviewed ? ' flag' : ''}`} data-pr={p.number}>
          <span className="cc-mono cc-pr-n">#{p.number}</span>
          <div className="cc-pr-body">
            <a className="cc-pr-title" href={p.url} target="_blank" rel="noreferrer">
              {p.title}
            </a>
            <span>
              <span className={`cc-tag ${p.unreviewed ? 'attn' : p.stage === 'deployed' ? 'ok' : 'cur'}`}>
                {STAGE_LABEL[p.stage]}
                {p.unreviewed ? ' · gate bypassed' : ''}
              </span>
            </span>
          </div>
          <PrSteps pr={p} />
        </div>
      ))}
    </>
  );
}

export function CommandCenterApp() {
  const { data, error } = useSWR<CommandCenter, Error>(ENDPOINT, fetchCommandCenter, {
    refreshInterval: REFRESH_MS,
  });
  const [filter, setFilter] = useState<HostSessionStatus | 'all'>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [showQuiet, setShowQuiet] = useState(false);

  if (!data) {
    const message =
      error instanceof CommandCenterError && error.status === 404
        ? 'The Command Center is visible to the owner only.'
        : error
          ? `Could not load the Command Center: ${error.message}`
          : 'Loading…';
    return (
      <div className="cc">
        <p className="cc-empty">{message}</p>
      </div>
    );
  }

  const now = Date.parse(data.generated_at);
  const sessions = orderSessions(data.sessions);
  const count = (st: HostSessionStatus) => sessions.filter((s) => s.status === st).length;
  const groups = STATUS_ORDER.map((status) => ({ status, items: sessions.filter((s) => s.status === status) })).filter(
    (g) => g.items.length > 0 && (filter === 'all' || filter === g.status),
  );
  const quietCount = sessions.filter((s) => QUIET.has(s.status)).length;
  const shownPrs = problemsOnly ? data.prs.filter(isProblem) : data.prs;
  const waitingToDeploy = data.prs.filter((p) => p.stage === 'merged');
  const prsKnown = data.prs_as_of !== null;
  const staleAge =
    data.prs_as_of !== null && now - Date.parse(data.prs_as_of) > PRS_STALE_MS ? relAge(data.prs_as_of, now) : null;
  const prCount = (keep: (p: PrRow) => boolean) => (prsKnown ? data.prs.filter(keep).length : '–');
  const time = signalStamp(data.generated_at, data.timezone);

  return (
    <div className={`cc${showQuiet ? ' cc-show-quiet' : ''}`}>
      <div className="cc-page">
        <header className="cc-header">
          <div className="cc-title">
            <span className={`cc-live${error ? ' stale' : ''}`} aria-hidden="true" />
            <h1>Command Center</h1>
            <span className="cc-mono cc-muted">{time}</span>
          </div>
          <div className="cc-mono cc-muted cc-meta">
            <span>live build {data.live_sha ? data.live_sha.slice(0, 9) : 'unknown'}</span>
            {error && <span className="cc-attn-text">refresh failed · showing {time}</span>}
          </div>
        </header>

        <section className="cc-totals" aria-label="Totals">
          <div className="cc-total attn">
            <strong>{count('needs_you')}</strong>
            <span>waiting on you</span>
          </div>
          <div className="cc-total work">
            <strong>{count('working')}</strong>
            <span>working now</span>
          </div>
          <div className="cc-total">
            <strong>{prCount((p) => p.stage === 'open')}</strong>
            <span>PRs open</span>
          </div>
          <div className="cc-total attn">
            <strong>{prsKnown ? data.gate_bypass_prs.length : '–'}</strong>
            <span>merged past the gate</span>
          </div>
        </section>

        <div className="cc-main">
          <section className="cc-sessions" aria-label="Sessions">
            <div className="cc-chips">
              <h2>Sessions</h2>
              {(['all', ...STATUS_ORDER] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`cc-chip${filter === id ? ' on' : ''}`}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {id === 'all' ? 'All' : GROUP_TITLE[id]}{' '}
                  <span className="cc-mono">{id === 'all' ? sessions.length : count(id)}</span>
                </button>
              ))}
            </div>
            {sessions.length === 0 && <p className="cc-empty">No live host sessions.</p>}
            {groups.map((g) => (
              <div key={g.status} className={`cc-group ${g.status}${QUIET.has(g.status) ? ' cc-quiet' : ''}`}>
                <h3 className="cc-group-title">
                  {GROUP_TITLE[g.status]} <span className="cc-mono">{g.items.length}</span>
                </h3>
                <div className="cc-tiles">
                  {g.items.map((s) => (
                    <article key={s.session_id} className={`cc-tile ${s.status}`} data-session={s.session_id}>
                      <span className="cc-mono cc-muted cc-cwd">{s.cwd}</span>
                      <span className="cc-tile-title">{s.title}</span>
                      <span className="cc-state">
                        <span className="cc-dot" aria-hidden="true" />
                        {sessionLine(s, now)}
                      </span>
                    </article>
                  ))}
                </div>
              </div>
            ))}
            {quietCount > 0 && (
              <button type="button" className="cc-more" onClick={() => setShowQuiet((v) => !v)}>
                {showQuiet ? 'Hide idle and shell' : `Show ${quietCount} idle and shell`}
              </button>
            )}
          </section>

          <section className="cc-shipping" aria-label="Shipping">
            <div className="cc-shipping-head">
              <h2>Shipping · last 7 days</h2>
              <button
                type="button"
                className={`cc-chip${problemsOnly ? ' on' : ''}`}
                aria-pressed={problemsOnly}
                onClick={() => setProblemsOnly((v) => !v)}
              >
                Problems only
              </button>
            </div>
            <div className="cc-pr cc-pr-head cc-mono">
              <span>PR</span>
              <span>Change</span>
              <span>open · merged · live</span>
            </div>
            {!prsKnown ? (
              <p className="cc-empty cc-attn-text">PRs unavailable: GitHub has not answered since the host started.</p>
            ) : (
              <>
                {staleAge && (
                  <p className="cc-attn-text cc-stale">PRs as of {staleAge} ago; GitHub refreshes are failing.</p>
                )}
                {shownPrs.length === 0 && <p className="cc-empty">No PRs to show.</p>}
                <PrList prs={shownPrs} />
                <p className="cc-foot">
                  Merged but not yet live:{' '}
                  {waitingToDeploy.length ? waitingToDeploy.map((p) => `#${p.number}`).join(', ') : 'none'}.
                </p>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
