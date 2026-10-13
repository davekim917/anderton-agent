import {
  addCounts,
  type AcceptedDetail,
  type AiCacheCounts,
  type AiFinding,
  type GateOutcome,
  type HoldReason,
} from './gate.js';

export const NO_CHANGES_EXIT = 4;

export interface Status {
  status: 'ok' | 'held' | 'failed';
  at: string;
  workflow?: string;
  dryRun: boolean;
  lastPublished: string | null;
  lastPassing: string | null;
  held?: { sha: string; reasons: HoldReason[] };
  /** How many AI findings accepted entries dropped; counts only. */
  acceptedFindings?: number;
  /** Batches the AI pass cache answered (hits) and the AI read (misses); counts only. */
  aiCache?: AiCacheCounts;
  error?: string;
}

export type StatusFields = Omit<Status, 'at' | 'dryRun'>;

type Workflow = 'export' | 'export_squash';

export interface ExportDeps {
  publicRemote: boolean;
  /** Strings that must never reach the status file, such as remote URLs. */
  redact: string[];
  writeStatus(fields: StatusFields): void;
  clearStatus(): void;
  writeHeldDetail(detail: { sha: string; aiFindings: AiFinding[] }): void;
  writeAcceptedDetail(accepted: AcceptedDetail[]): void;
  stagingHead(): string | null;
  resetStaging(sha: string | null): void;
  copybara(workflow: Workflow, initHistory: boolean): number;
  newCommits(base: string | null, head: string): string[];
  gate(shas: string[]): Promise<GateOutcome>;
  remoteHead(): string | null;
  push(sha: string): void;
  /** Forget every cached AI pass, so nothing judged before a publish is skipped after it. */
  clearAiCache(): void;
}

function trustedGatedHead(deps: Pick<ExportDeps, 'publicRemote' | 'remoteHead'>): string | null {
  return deps.publicRemote ? deps.remoteHead() : null;
}

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('<redacted>');
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<redacted>@');
}

export function failedStatus(error: unknown, secrets: string[]): StatusFields {
  return {
    status: 'failed',
    lastPublished: null,
    lastPassing: null,
    error: redactText(error instanceof Error ? error.message : String(error), secrets),
  };
}

interface Exported {
  passing: string | null;
  held?: GateOutcome['held'];
  accepted?: AcceptedDetail[];
  aiCache?: AiCacheCounts;
}

async function exportAndGate(deps: ExportDeps, base: string | null, workflow: Workflow): Promise<Exported> {
  const code = deps.copybara(workflow, base === null);
  if (code === NO_CHANGES_EXIT) return { passing: base };
  if (code !== 0) throw new Error(`copybara ${workflow} exited ${code}`);
  const head = deps.stagingHead();
  const outcome = await deps.gate(head ? deps.newCommits(base, head) : []);
  const passing = outcome.lastPassing ?? base;
  if (outcome.held) deps.resetStaging(passing);
  return { passing, held: outcome.held, accepted: outcome.accepted, aiCache: outcome.aiCache };
}

export async function runExport(deps: ExportDeps): Promise<number> {
  try {
    const trusted = trustedGatedHead(deps);
    if (deps.stagingHead() !== trusted) deps.resetStaging(trusted);
    let workflow: Workflow = trusted === null ? 'export_squash' : 'export';
    let result = await exportAndGate(deps, trusted, workflow);
    const accepted = [...(result.accepted ?? [])];
    let aiCache = result.aiCache;
    if (result.held && workflow === 'export') {
      workflow = 'export_squash';
      result = await exportAndGate(deps, result.passing, workflow);
      accepted.push(...(result.accepted ?? []));
      if (result.aiCache) aiCache = addCounts(aiCache, result.aiCache);
    }
    if (accepted.length > 0) deps.writeAcceptedDetail(accepted);
    if (result.held) deps.writeHeldDetail({ sha: result.held.sha, aiFindings: result.held.aiFindings });

    let published: string | null = null;
    if (deps.publicRemote) {
      published = trusted;
      if (result.passing && result.passing !== trusted) {
        deps.push(result.passing);
        published = result.passing;
        deps.clearAiCache();
      }
    }
    deps.writeStatus({
      status: result.held ? 'held' : 'ok',
      workflow,
      lastPublished: published,
      lastPassing: result.passing,
      held: result.held ? { sha: result.held.sha, reasons: result.held.reasons } : undefined,
      ...(accepted.length > 0 ? { acceptedFindings: accepted.length } : {}),
      ...(aiCache ? { aiCache } : {}),
    });
    return result.held ? 2 : 0;
  } catch (error) {
    try {
      deps.writeStatus(failedStatus(error, deps.redact));
    } catch {
      deps.clearStatus();
    }
    return 1;
  }
}
