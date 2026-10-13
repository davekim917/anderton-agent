import { describe, expect, it } from 'vitest';

import { NO_CHANGES_EXIT, redactText, runExport, type ExportDeps, type StatusFields } from './export-flow.js';
import type { AcceptedDetail, GateOutcome } from './gate.js';

type Workflow = 'export' | 'export_squash';

interface World {
  staging: string[];
  remote: string | null;
  pushes: string[];
  workflows: Workflow[];
  gated: string[][];
  status: StatusFields | null;
  accepted?: AcceptedDetail[];
  events: string[];
}

function harness(
  world: World,
  opts: {
    publicRemote: boolean;
    copybara: (w: World, workflow: Workflow) => number;
    gate?: (shas: string[]) => GateOutcome;
    writeStatus?: ExportDeps['writeStatus'];
    clearStatus?: ExportDeps['clearStatus'];
    pushFails?: boolean;
  },
): ExportDeps {
  return {
    publicRemote: opts.publicRemote,
    redact: ['https://ghp_fixturetoken@example.com/owner/repo.git'],
    writeStatus:
      opts.writeStatus ??
      ((fields) => {
        world.status = fields;
      }),
    clearStatus:
      opts.clearStatus ??
      (() => {
        world.status = null;
      }),
    writeHeldDetail: () => {},
    writeAcceptedDetail: (accepted) => {
      world.accepted = accepted;
    },
    stagingHead: () => world.staging.at(-1) ?? null,
    resetStaging: (sha) => {
      if (sha === null) world.staging = [];
      else if (world.staging.includes(sha)) world.staging = world.staging.slice(0, world.staging.indexOf(sha) + 1);
      else if (sha === world.remote) world.staging = [sha];
      else throw new Error(`no such commit ${sha}`);
    },
    copybara: (workflow) => {
      world.workflows.push(workflow);
      return opts.copybara(world, workflow);
    },
    newCommits: (base, head) =>
      world.staging.slice(base ? world.staging.indexOf(base) + 1 : 0, world.staging.indexOf(head) + 1),
    gate: async (shas) => {
      world.gated.push(shas);
      return opts.gate ? opts.gate(shas) : { lastPassing: shas.at(-1) ?? null };
    },
    remoteHead: () => world.remote,
    push: (sha) => {
      if (opts.pushFails) throw new Error('push rejected');
      world.pushes.push(sha);
      world.events.push(`push ${sha}`);
      world.remote = sha;
    },
    clearAiCache: () => {
      world.events.push('clear ai cache');
    },
  };
}

function world(overrides: Partial<World> = {}): World {
  return { staging: [], remote: null, pushes: [], workflows: [], gated: [], status: null, events: [], ...overrides };
}

const adds =
  (...shas: string[]) =>
  (w: World) => {
    w.staging.push(...shas);
    return 0;
  };
const holdOn =
  (...heldShas: string[]) =>
  (shas: string[]): GateOutcome => {
    const index = shas.findIndex((sha) => heldShas.includes(sha));
    if (index < 0) return { lastPassing: shas.at(-1) ?? null };
    return {
      lastPassing: index === 0 ? null : shas[index - 1],
      held: {
        sha: shas[index],
        reasons: [{ source: 'scanner', where: 'a.ts:1', category: 'private-identifier' }],
        aiFindings: [],
      },
    };
  };

describe('runExport publishes only what this run gated on top of the public head', () => {
  it('pushes every commit gated after the public head', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    expect(await runExport(harness(w, { publicRemote: true, copybara: adds('s2', 's3') }))).toBe(0);
    expect(w.workflows).toEqual(['export']);
    expect(w.gated).toEqual([['s2', 's3']]);
    expect(w.pushes).toEqual(['s3']);
    expect(w.status).toMatchObject({ status: 'ok', lastPublished: 's3' });
  });

  it('re-gates a head an earlier run gated but never pushed, and does not push it once the inventory flags it', async () => {
    const w = world({ staging: ['s1', 's2'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: holdOn('s2', 'sq'),
      }),
    );
    expect(code).toBe(2);
    expect(w.gated[0]).toEqual(['s2']);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
  });

  it('re-exports and re-gates everything when there is no public head', async () => {
    const w = world({ staging: ['dry-run-head'] });
    const stagingAtExport: string[][] = [];
    await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw) => {
          stagingAtExport.push([...cw.staging]);
          return adds('fresh')(cw);
        },
      }),
    );
    expect(stagingAtExport).toEqual([[]]);
    expect(w.workflows).toEqual(['export_squash']);
    expect(w.gated).toEqual([['fresh']]);
    expect(w.pushes).toEqual(['fresh']);
  });

  it('never publishes a staging commit this run did not gate', async () => {
    const w = world({ staging: ['s1', 'ungated'], remote: 's1' });
    expect(await runExport(harness(w, { publicRemote: true, copybara: () => NO_CHANGES_EXIT }))).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.staging).toEqual(['s1']);
  });

  it('pushes nothing on a dry run', async () => {
    const w = world();
    expect(await runExport(harness(w, { publicRemote: false, copybara: adds('s1') }))).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.status).toMatchObject({ status: 'ok', lastPassing: 's1', lastPublished: null });
  });
});

describe('runExport holds and recovers within one run', () => {
  it('pushes the passing prefix and holds when the squash of the rest still holds', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 's3', 's4')(cw) : adds('sq')(cw)),
        gate: holdOn('s3', 'sq'),
      }),
    );
    expect(code).toBe(2);
    expect(w.workflows).toEqual(['export', 'export_squash']);
    expect(w.gated).toEqual([['s2', 's3', 's4'], ['sq']]);
    expect(w.pushes).toEqual(['s2']);
    expect(w.staging).toEqual(['s1', 's2']);
    expect(w.status).toMatchObject({ status: 'held', lastPublished: 's2', held: { sha: 'sq' } });
  });

  it('publishes the squash when a later private commit removed what held', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 'fix')(cw) : adds('sq')(cw)),
        gate: holdOn('s2'),
      }),
    );
    expect(code).toBe(0);
    expect(w.pushes).toEqual(['sq']);
    expect(w.status).toMatchObject({ status: 'ok', held: undefined });
  });

  it('reports ok when the held delta was fully reverted, so the squash has nothing to add', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2', 'revert')(cw) : NO_CHANGES_EXIT),
        gate: holdOn('s2'),
      }),
    );
    expect(code).toBe(0);
    expect(w.pushes).toEqual([]);
    expect(w.status).toMatchObject({ status: 'ok', held: undefined, lastPublished: 's1' });
  });
});

describe('runExport when the status cannot be written', () => {
  it('removes the stale status instead of leaving a previous ok behind', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    let cleared = false;
    const deps = harness(w, {
      publicRemote: false,
      copybara: adds('s2'),
      writeStatus: () => {
        throw new Error('disk full');
      },
      clearStatus: () => {
        cleared = true;
      },
    });
    await expect(runExport(deps)).resolves.toBe(1);
    expect(cleared).toBe(true);
  });
});

describe('runExport keeps credentials out of the status', () => {
  it('redacts the remote URL and any URL credentials from a failure', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const deps = harness(w, { publicRemote: true, copybara: adds('s2') });
    deps.push = () => {
      throw new Error(
        'Command failed: git push -q https://ghp_fixturetoken@example.com/owner/repo.git s2:refs/heads/main; also https://user:pw@localhost/x',
      );
    };
    expect(await runExport(deps)).toBe(1);
    expect(w.status?.status).toBe('failed');
    expect(w.status?.error).not.toContain('ghp_fixturetoken');
    expect(w.status?.error).not.toContain('user:pw');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactText('copybara export exited 1', ['https://x@h/r'])).toBe('copybara export exited 1');
  });
});

describe('runExport reports accepted findings as a count only', () => {
  it('counts and records the accepted findings of the per-commit attempt and its squash retry', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    const code = await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: (shas) => ({
          ...holdOn('s2')(shas),
          accepted: [{ sha: shas[0], finding: { file: 'a.ts', line: 1, text: 't', why: 'w' } }],
        }),
      }),
    );
    expect(code).toBe(0);
    expect(w.status).toMatchObject({ status: 'ok', acceptedFindings: 2 });
    expect(w.accepted?.map((entry) => entry.sha)).toEqual(['s2', 'sq']);
  });
});

describe('runExport reports the AI pass cache as counts', () => {
  it('sums the per-commit attempt and its squash retry into the status', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    await runExport(
      harness(w, {
        publicRemote: true,
        copybara: (cw, workflow) => (workflow === 'export' ? adds('s2')(cw) : adds('sq')(cw)),
        gate: (shas) => ({ ...holdOn('s2')(shas), aiCache: { hits: 3, misses: 1 } }),
      }),
    );
    expect(w.status).toMatchObject({ aiCache: { hits: 6, misses: 2 } });
  });
});

describe('runExport clears the AI pass cache only after it publishes', () => {
  it('clears it once the push has landed', async () => {
    const w = world({ staging: ['s1'], remote: 's1' });
    await runExport(harness(w, { publicRemote: true, copybara: adds('s2') }));
    expect(w.events).toEqual(['push s2', 'clear ai cache']);
  });

  it.each<[string, Partial<World>, Parameters<typeof harness>[1]]>([
    ['a dry run', {}, { publicRemote: false, copybara: adds('s1') }],
    [
      'a run with nothing new',
      { staging: ['s1'], remote: 's1' },
      { publicRemote: true, copybara: () => NO_CHANGES_EXIT },
    ],
    ['a run whose only commit held', {}, { publicRemote: true, copybara: adds('s1'), gate: holdOn('s1') }],
    [
      'a push that failed',
      { staging: ['s1'], remote: 's1' },
      { publicRemote: true, copybara: adds('s2'), pushFails: true },
    ],
  ])('keeps it after %s, so a retry still skips what passed', async (_label, start, opts) => {
    const w = world(start);
    await runExport(harness(w, opts));
    expect(w.events).not.toContain('clear ai cache');
  });
});
