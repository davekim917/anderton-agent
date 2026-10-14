---
name: verify-nanoclaw
description: Boot an isolated second NanoClaw host beside the live fleet, from a throwaway worktree at any revision, drive it the way a user does (CLI chat to an agent, host restart and container adoption), and record evidence a reviewer can check. Use to prove a host or agent-runner change end to end before or after merge. Host session only; a container cannot boot a host. Never targets the live instance.
---

# verify-nanoclaw

Proves NanoClaw behaviour on a second host that shares the machine, the Docker daemon and the OneCLI gateway with the production fleet. Everything else is separate: its own worktree, install, `data/`, `groups/`, scratch `HOME` and `TMPDIR`, port, install slug (container label) and image tag. The live instance is never driven, restarted or reconfigured.

All steps go through one helper, `scripts/verify-nanoclaw.sh` in this directory. Every call stands alone: pass the run directory on every call. It prints `RUN=<dir>` from `launch`.

```bash
S=<this skill dir>/scripts/verify-nanoclaw.sh
$S launch [<revision>]          # default origin/main; prints RUN=<evidence dir>
$S doctor  "$RUN"
$S seed    "$RUN"
$S chat    "$RUN" "<text>"
$S restart "$RUN"
$S guard   "$RUN"
$S cleanup "$RUN"               # always, after success or failure
```

From a container session: read `features/` and the evidence a host run left, or ask the host to run it. Don't try to launch.

## Project

- **Binding:** `github.com/davekim917/nanoclaw`. `launch` and `doctor` compare it with this checkout's `origin` (credentials stripped) and stop on a mismatch. The helper builds whatever revision you name from that repository's object store, in a new detached worktree. Its own checkout can be any worktree of the repo, but never use the checkout to build or boot.
- **Placement:** this skill is committed to the repo because its owner opted in. The repository is the owner's own, so a `verify-*` directory here is not a change to someone else's repo. Its evidence still stays private.
- **Proven against:** a03448ea0 (origin/main, 2026-10-14), with this helper's first version. The run's evidence is in the private directory below. That revision predates `NANOCLAW_ONECLI_APPROVALS`, so the current helper refuses it: only revisions that carry both shared-service switches can be booted.
- **Private directory:** `~/.agents/skills/verify-nanoclaw/`, outside every checkout. It holds `evidence/` (one directory per run) and the run lock `.inuse`. Scratch state (worktree, HOME, TMPDIR) goes under `~/scratch/verify-nanoclaw/<run id>/`, and cleanup deletes it.
- **Live instance:** found from the systemd unit's `WorkingDirectory` (`VERIFY_LIVE_UNIT`, default `nanoclaw-v2`). Its slug is `sha1(path)[:8]`. The helper refuses to build or boot at that path or with that slug.

## Launch

`launch [<revision>]`:

1. Checks the binding, fetches and resolves the revision, and creates the run directory and its `state`. Then it takes the lock with a create that fails if `.inuse` exists: another run holds the machine until its cleanup. From then on, any failure runs the full `cleanup` before `launch` exits.
2. Records the baseline: running containers counted per `nanoclaw-install` label, every image tag, the live unit's MainPID, the live log's byte offset, and the OneCLI agent identifiers.
3. Runs `git worktree add --detach` at the revision.
4. Starts a `docker events` recorder for container and image events.
5. Runs `pnpm install --frozen-lockfile --offline` and `pnpm run build`, niced. The build runs with `BUILD_ALLOW_LOCAL=1`, since its freshness check refuses any HEAD but `origin/main` and a PR head is a valid target; doctor checks that `dist/BUILD_INFO.json` names the worktree HEAD.
6. Tags the live image as `nanoclaw-agent-v2-<slug>:latest` when the runner deps hash matches. Otherwise it stops, unless `VERIFY_BUILD_IMAGE=1`, which runs `./container/build.sh` into that tag.
7. Writes the worktree `.env` (mode 600). It contains:
   - port 3999 (`VERIFY_PORT`) and an explicit `ONECLI_URL`, plus the live install's `ONECLI_API_KEY` if it has one. The key stays in the scratch worktree and never reaches evidence.
   - `NANOCLAW_ONECLI_APPROVALS=0`. The gateway hands every pending approval to every polling host and keeps the first decision, so without this the verify host would answer the fleet's credential requests.
   - `NANOCLAW_STORAGE_MANAGER_ENABLED=0`. A storage pass prunes daemon-wide build cache, and under disk pressure it can remove images no running container references, live ones included.
   - one container at 1g, the canvas and summary modules off, and no channel tokens.
8. Stamps the upgrade marker (a fresh `data/` otherwise trips the upgrade tripwire).
9. Runs the pre-boot doctor.
10. Starts `node dist/index.js` under `env -i` with the scratch `HOME`/`TMPDIR`, `setsid`, ionice and nice.

Ready means `ncl groups list` answers over the worktree's socket, which happens only after every boot gate. A plain socket bind is not ready. `host.log` should show `Reconciled sessions at startup adopted=0 stopped=0`, `OneCLI preflight ok`, `Webhook server started port=3999`, and `cli` as the only adapter.

Teardown is `cleanup`.

## Doctor

`doctor "$RUN"` is read-only. It checks:
- the worktree is not the live path and its slug is not the live slug
- no `SLACK_*`/`DISCORD_*` keys in `.env`, and the port is not the live port
- `dist/BUILD_INFO.json` names the worktree HEAD, and the image exists
- the build reads both `NANOCLAW_ONECLI_APPROVALS` and `NANOCLAW_STORAGE_MANAGER_ENABLED`. A revision without them is refused before boot, because the `.env` lines would be inert
- `.env` keeps the host off the approval queue and disables the storage manager, and `host*.log` shows neither `OneCLI approval handler started` nor a storage pass
- the host PID is the process this run started (PID plus start time), its `/proc/<pid>/environ` has the scratch `HOME` and `TMPDIR`, and it owns the port (`ss`)
- `ncl` answers

It warns if the live MainPID changed since launch. Run it first whenever anything looks off.

## Drive

- `seed "$RUN"` creates the CLI agent (`scripts/init-cli-agent.ts`, folder `verify-cli`). It sets `provider: mock` and `outcomeReporting: false` in that group's `container.json`, and restarts its container through `ncl groups restart` if one is already running.
- `chat "$RUN" "<text>"` sends a message over the CLI channel (`scripts/chat.ts`). Each call is numbered `<n>` and keeps its own files: the text sent, stdout, stderr, the exit code, the session DBs' `messages_in`, `delivered` and `messages_out` rows, and `docker inspect` plus mount sources for this install's containers. A failed query or inspect is written into its file and the rest is still recorded. The inspect files are mode 600 with proxy credentials redacted, since the container's proxy URL carries the agent's gateway token.
- `restart "$RUN"` stops the host (SIGTERM), records which of its containers survived, and boots it again.

What each feature must show is in [features/README.md](features/README.md).

## Evidence

Each run is `~/.agents/skills/verify-nanoclaw/evidence/<UTC>-<rev9>-<rand>/`, created with a plain `mkdir` that fails if the path exists. The helper writes these files there:
- `state`: run facts, one `KEY=value` per line
- `host*.log`
- `labels-before.txt` and `labels-after.txt`
- `images-before.txt` and `images-after.txt`
- `onecli-agents-before.txt` and `onecli-agents-after.txt`
- `docker-events.log`
- per chat `<n>`: `chat-<n>.{sent,stdout,stderr,exit}`, `session-db-<n>.txt`, `container-<name>-<n>.json`, `container-<name>-<n>.mounts.txt`
- `live-after.txt`, `guard.txt` and `cleanup.txt` (each cleanup step `ok:` or `FAILED:`)

You write `record.md`:
- the revision, plus the helper's sha256 if it was edited
- per feature: action, result, side effects checked, mocks, and gaps (with why)
- any `FAILED:` line from `cleanup.txt`, first

A feature you could not reach is `unreachable`, with the prerequisite and what you tried; it never counts as passed. Never rewrite an expectation to match what a regression now does.

Proof standards:
- Drive the CLI channel, not DB inserts.
- Show the reply and the rows behind it.
- Show that the verify container's mounts all sit under the run's scratch directory.

Mocks in a standard run:
- the `mock` provider (replies `Mock response to: <first 100 chars of the prompt>`)
- outcome reporting off on the verify group
- the CLI socket as the only channel

## Cleanup

`cleanup "$RUN"`:
1. SIGTERMs the host by its recorded PID, only if that PID's start time still matches the one recorded at launch.
2. Stops this install's containers by label: the host deliberately leaves them running for adoption, and nothing is ever stopped by name prefix. It first re-checks that the slug is not the live install's, and if it is, stops nothing. A failed listing is a failed step.
3. Deletes the run's OneCLI agent by its identifier. A failed delete, or a failed or malformed agent listing, writes `ONECLI AGENT NOT DELETED` / `MAY REMAIN` to `cleanup.txt` and stderr: the agent's token stays valid in the shared gateway until someone deletes it by hand.
4. Removes the image tag only if this run added it.
5. Stops the events recorder (after checking its PID's start time) and records that it did, records the after-state, then runs `guard`. A recorder that died early is a failed step.
6. Removes the worktree (`--force`, since it holds untracked runtime data) and the scratch directory.
7. Releases the lock if it still holds this run's holder id.

Each step runs whatever an earlier one did. `cleanup` exits non-zero if guard failed (exit 3) or any step failed, after finishing the rest. Evidence stays. Run it after every failed step too: it tolerates a partial run.

`guard "$RUN"` exits 3 if any of these happened:
- the verify host's logs name a container that does not carry this run's label
- the verify host stopped anything at boot
- a live-labelled container got `stop`/`kill` during the run and the live host's own log (from the recorded offset) has no stop record for it: a `Killing container` or `Container stopped by host` line naming it
- a shared unlabelled container (the live install's `ONECLI_GATEWAY_CONTAINER`, default `onecli`, and `onecli-postgres`) got `stop`/`kill` during the run, whatever stopped it
- the events recorder logged anything but events, or is not running and cleanup did not stop it: past that point the run is unaudited
- an image tag other than this run's got `untag`/`delete`, or an image tag present at launch is gone (untag and delete events can name an image by ID alone, so the inventory is the check that cannot miss one)

A `Container exited` line does not count as a stop record, because the live host logs it whoever stopped the container. The live fleet's own idle reaps are counted, not flagged. A live deploy or storage pass that removes a tag during the run does trip guard; check the live log, then rerun. `tests/guard.test.ts` pins each of these cases. If guard fails during a run, run `cleanup` immediately and report.

## Helpers

`scripts/verify-nanoclaw.sh` is executable and its subcommands are listed above. `launch` reads these knobs, set on its own command line: `VERIFY_PORT`, `VERIFY_ONECLI_URL`, `VERIFY_LIVE_UNIT`, `VERIFY_BUILD_IMAGE`, `VERIFY_HOLDER`. It records them in the run's `state`, which is the only thing later calls read, so nothing needs exporting between tool calls.

Keep the map current with `maintain-verification-skill` (bootstrap `verification-skills` plugin).
