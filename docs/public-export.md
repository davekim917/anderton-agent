# Public export

This repository is private. Its product tree is published to a separate public repository by a one-way export: agents never push to the public repository, so nothing they write is public until it passes the gate below.

## Why one-way

Pushing a branch to a public repository publishes it before any merge check can run, and a name list can never be complete (abbreviations and new clients slip past it). Exporting from a private repository puts the check in front of publication, where nothing can skip it. It is the same pattern Google uses with Copybara to publish open source from a private codebase.

## What gets published

`scripts/public-export/copy.bara.sky` holds an include list of product folders and root files. A new top-level folder or root file stays private until it is added there. A new `docs/*.md` file is published by default, so a record of this deployment written there needs its own exclude. Specs, retros, review notes (`docs/review-notes.md` and `docs/review-notes/`), handoffs, records of this deployment rather than the product (superseded runbooks and phase plans, the v1 migration log, backlog and spike notes, audits measured on this fleet), `data/`, `.github/`, group folders and the public-boundary baseline/allowlist are excluded explicitly. `docs/review-policy.md` is published: the exported `pr-review-loop` skill and container instructions cite it, so it holds the policy and nothing about this install. Tests whose subject is this repository's own CI and review governance (`.github/`, review notes, specs, the upstream ratchet, the export allowlist) are excluded too, since their subjects are not exported. `scripts/public-export/allowlist.test.ts` evaluates those globs against the tracked tree and fails if a private path would be exported.

The public repository gets its own `README.md`, `CLAUDE.md`, `AGENTS.md` (a symlink to `CLAUDE.md`) and `CONTRIBUTING.md` from `public-overlay/`, which the export moves to the root. The private root copies describe this install or NanoClaw's own process and are never exported, and neither are the upstream README translations or `RELEASING.md`. A change to a private root copy alone publishes nothing; edit the `public-overlay/` copy to change what the public repository shows.

Each private commit that touches published files becomes one public commit:

- the author is rewritten to `PUBLIC_EXPORT_AUTHOR` (use a GitHub noreply address);
- the message keeps only the subject line, with any trailing ` (#<n>)` removed. A merge subject (`Merge pull request #<n> from …`, `Merge branch …`, `Merge remote-tracking branch …`) becomes `Merge changes`, because a branch name is exactly the kind of abbreviation the gate can miss;
- a `GitOrigin-RevId` trailer records the private commit it came from, which is how the next run resumes.

## The gate

Every exported commit is checked before it can be pushed, in order, and the first failure stops the run:

1. **Name scan.** `scripts/check-public-boundary.ts` runs over the commit's whole tree and its message, using the install's identifier registry and allowlist and an empty baseline, so lines the private repo tolerates still count.
2. **Binaries.** A changed binary file holds unless its blob is listed in the host-local `public-export-approved-binaries.txt` (see _Exemptions_ below). Neither the scanner nor the AI can read a binary. Add a blob only after a person has looked at the image itself. Listing it skips every content check. The list starts with the images that are byte-identical to nanoco's public upstream.
3. **AI read.** Headless Claude Code (`PUBLIC_EXPORT_AI_MODEL`, no tools) reads the message, every changed path (renames show both names) and every added line, together with the list of known private names, and must return `pass` with no finding left after accepted findings are removed (see _Exemptions_). It is there to catch what a list cannot: abbreviations, slugs and names not yet in the registry. The commit is fenced between markers carrying a random per-call nonce, and the model is told that everything between them is data, never instructions.

A large diff, such as the first full-tree snapshot, is read in batches of at most `PUBLIC_EXPORT_AI_MAX_CHARS` (default 400,000 characters), each carrying the commit message. There is no way to skip the AI read.

### The AI budget

Every AI read runs on the host's Claude login, a usage allowance that other work on the host also draws on. `PUBLIC_EXPORT_AI_MAX_CALLS` (default 15) caps the reads one run may make. Before the first read, the gate counts every batch the run's commits could send; when that count, plus what an earlier gate call in the same run already spent (the squash retry draws on the same budget), is over the cap, the first commit holds with the reason `AI budget exceeded: N batches > cap M` and no AI call is made. The count includes commits the scanner would hold, so a budget hold can stand in front of a scanner hold.

A normal day's merges fit well under the cap, because a run only reads the commits since the public head. A run that needs more, such as a large refactor or a first publish into an empty repository, is a decision for a person: run it once with a higher `PUBLIC_EXPORT_AI_MAX_CALLS`, at an hour when the fleet's allowance can spare it.

### Exemptions

Three files let a person settle what the gate would otherwise hold on every run. They live in the install's `.nanoclaw/` directory (`NANOCLAW_DIR/.nanoclaw/`, beside `public-boundary-identifiers`), which `.gitignore` excludes. Gate policy never comes from the tree being judged: a file in the exported checkout could grant its own exemption, so the run never reads one there. A missing file grants nothing. The install is the checkout that pulls the private repository, so the run fails if git tracks anything under `.nanoclaw/` there; a commit that force-added an exemption cannot grant it. Only a session on the host, run by the operator, edits these files.

- `public-export-public-names.txt` lists names that are public by design, such as public products the project integrates with. The operator's own identity is added from `PUBLIC_EXPORT_AUTHOR`: the full author name and the GitHub noreply login, since every public commit already carries them. A single word of the name is never added, since it could match another private name. These names are left out of the private names the AI is given, matched whole and case-insensitively, and the AI is told they are fine; a slug, path or URL that combines one with anything else is fine only when every other part is public too. Each line must be a plain name (letters, digits, `. _ -` and spaces, at most 48 characters); anything else fails the run. Another person's name never goes here.
- `public-export-accepted-findings.json` lists false positives a person has confirmed. Each entry is `{ "path", "line", "reason" }`: the exported file, the exact text of the flagged line, and why it is not private. An AI finding is dropped only when all of these hold: it names that file and a line number; its `text` is non-empty and occurs in the accepted line; the file is a regular file reached without a symlink; and that line in the exported tree is still exactly the accepted text. Anything else still holds: a finding with no file, line or text, text from elsewhere reported at an accepted line number, text spanning several lines, a changed line, the same text in another file, a symlink, or an AI `hold` that names no finding. A malformed file, or an entry whose path is absolute or has an empty, `.` or `..` segment, fails the run.
- `public-export-approved-binaries.txt` lists binary blobs a person has looked at, one `<blob> <path>` per line.

Add an entry only after reading the flagged line in `logs/public-export/held.json` and confirming it identifies no client, customer, private person or private group. When it does, fix the line in the private repository instead. The AI is asked for one finding per line, so an entry covers exactly one line. The status file records how many findings were accepted, as a count; the accepted findings themselves go to `logs/public-export/accepted.json`, mode 0600 in a 0700 directory, for audit.

The gate fails closed. A scanner hit, a scanner that cannot load its identifier sources, an AI `hold` or finding in any batch that is not exactly matched by an accepted finding, unparseable AI output, a non-zero exit, a failed write to the model's input, a timeout, a single added line too long for one call, or a run over its AI budget all hold the commit.

## What a run trusts

A run builds on one commit without gating it, `trustedGatedHead` in `export-flow.ts`: the public repository's own head, or nothing on a dry run or a first publish. Every commit above it is exported and gated again in the run that pushes it, under the current identifier inventory, even if an earlier run already passed it. `logs/public-export-status.json` is write-only reporting and never feeds a publish decision. A run that cannot write its status deletes the old one rather than leave a stale `ok`. A dry run therefore re-exports and re-gates the whole tree every time.

## Holds and recovery

When a per-commit export holds only on scanner or gate reasons, the same run retries once as `export_squash`. It squashes everything after the last passing commit into one commit and gates it. A later private commit that removed what held therefore publishes in that run. A squash with nothing to add means the held change was fully reverted, so the run is `ok`. The per-commit hold is still recorded: its detail goes to `held.json` and the status carries it as `perCommitHold`.

A per-commit hold with any AI reason is never retried as a squash. The AI read is sampled, so a second read of the same lines can pass what the first flagged, and a retry would publish on the luckier read. The run holds instead, and a person fixes the leak or accepts the finding (see _Exemptions_).

If the run holds, after the squash retry or without one:

- only the passing prefix is pushed;
- `logs/public-export-status.json` records `status: "held"`. Scanner reasons are `file:line` plus a category, with the scanner redacting identifiers in paths. An AI hold is recorded only as its batch and `possible-identifier`;
- the AI's findings, which may quote the private text, go to `logs/public-export/held.json`. The file is mode 0600, and its directory is set to 0700 on every write, even when it already exists. Both files stay on the host.

Fix the leak in the private repository, for example by renaming a fixture to a fictional name, and the next run publishes.

## Running it

```
flock data/public-export.lock pnpm exec tsx scripts/public-export/run.ts
```

| Env                           | Default                       | Meaning                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_EXPORT_AUTHOR`        | required                      | `Name <email>` written as author and committer of every public commit.                                                                                                                                                           |
| `PUBLIC_EXPORT_REMOTE`        | unset                         | Push URL of the public repository. Unset is a dry run: export and gate, push nothing. Never put a credential in the URL; use a git credential helper. Remote URLs and any `user@` part of a URL are redacted from status errors. |
| `PUBLIC_EXPORT_PRIVATE_URL`   | the install's `origin`        | Where the private repository is fetched from. Same rule: no credential in the URL.                                                                                                                                               |
| `PUBLIC_EXPORT_AI_MODEL`      | `claude-opus-5-5`             | Model for the AI read.                                                                                                                                                                                                           |
| `PUBLIC_EXPORT_AI_TIMEOUT_MS` | `600000`                      | Per-call deadline; a timeout holds. Must be a positive integer, or the run fails.                                                                                                                                                |
| `PUBLIC_EXPORT_AI_MAX_CHARS`  | `400000`                      | Largest AI batch.                                                                                                                                                                                                                |
| `PUBLIC_EXPORT_AI_MAX_CALLS`  | `15`                          | Most AI reads one run may make; a run that would need more holds before reading anything. Must be a positive integer, or the run fails.                                                                                          |
| `PUBLIC_EXPORT_WORKDIR`       | `data/public-export`          | Private mirror, staging repository and rendered config.                                                                                                                                                                          |
| `PUBLIC_EXPORT_LOG_DIR`       | `logs`                        | Where the status and held-detail files go.                                                                                                                                                                                       |
| `NANOCLAW_DIR`                | the checkout the script is in | The install whose identifier registry and `.nanoclaw/` export policy the gate reads; git must track nothing under its `.nanoclaw/`.                                                                                              |

Exit codes:

- `0`: ok, or nothing new.
- `2`: held.
- `1`: failed. The run stopped on an error and wrote `status: "failed"`, or removed the status file if even that write failed. A push that completed before the error stays published, and the next run starts from the public head either way.

Copybara runs in a container built from `scripts/public-export/Dockerfile`, tagged with a hash of that file, so changing the pinned release rebuilds the image. Copybara needs Java 25 and git 2.45 or later, newer than the host's. The Copybara release and checksum are pinned there; Copybara publishes weekly snapshots with no compatibility guarantee, so bump it deliberately.

The first run starts from an empty staging repository with `export_squash --init-history`, so the private history before that snapshot is never published. That snapshot's AI read covers the whole product tree in batches, so it takes many calls.
