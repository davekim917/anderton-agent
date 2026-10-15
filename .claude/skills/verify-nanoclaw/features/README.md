# NanoClaw verification map

The maintained source for verifying what a NanoClaw user sees. Read this before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `launch` succeeded and `doctor` reports ok for this run's directory.
- `seed` ran once, so the CLI agent `verify-cli` exists on `provider: mock` with outcome reporting off.
- Nothing in this map touches the live instance; `guard` passes at the end of every run.

## Proof and skip reporting

- A chat proof has the reply on stdout, the inbound `chat` row, the outbound `chat` row and its `delivered` stamp.
- A container proof has its `nanoclaw-install` label and mount sources, every one under the run's scratch directory.
- Name the entry point each artifact came from. A skipped entry point is a gap, never passed through a different one.

## Features

- [CLI chat](./cli-chat.md): a message sent on the CLI channel reaches the agent's container and its reply comes back. Proven 2026-10-14 on 3a2cd6899.
- [Restart and adoption](./restart-adoption.md): a host restart leaves the agent's container running, re-adopts it, and it keeps answering. Proven 2026-10-14 on 3a2cd6899.
- [ncl admin](./ncl-admin.md): operator commands over the host socket. Not yet proven beyond `groups list` and `groups restart`.
