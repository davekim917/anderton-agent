# ncl admin

The operator manages agent groups, wirings, users, tasks and secrets with `ncl` over the host's Unix socket (`data/ncl.sock`).

## Sub-features

- `groups-list`: lists agent groups. Used as the readiness probe.
- `groups-restart`: restarts one group's container. Used by `seed`.
- Not yet mapped: `tasks`, `destinations`, `members`, `secrets`, `groups config update`.

## How to get to it (user POV)

- `pnpm run ncl <resource> <verb>` in the install's checkout (`src/cli/client.ts`).

## Driving it with verify-nanoclaw.sh

Preconditions:

- The baseline from the README.

- **List.** `doctor` runs `ncl groups list` against the worktree's socket and fails if it does not answer.
- **Restart.** `seed` runs `ncl groups restart --id <group>` when a container is already up. `seed.txt` shows `"restarted": 1`.

## Gotchas

- Requests answer `not-ready` until every boot gate has passed. A bound socket is not readiness.
- `groups config update --provider` and `-m` changes need a container restart to take effect.
- This feature has only incidental coverage so far. Mark any sub-feature not driven as a gap in `record.md`.
