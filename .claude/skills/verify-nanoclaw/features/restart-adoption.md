# Restart and adoption

When the host process restarts, a running agent container is not stopped. The new host adopts it, and the conversation keeps working without a new spawn.

## Sub-features

- `survive-stop`: SIGTERM to the host leaves the container running.
- `adopt`: the next boot reports `adopted=1 stopped=0` for this install.
- `answer-after-adopt`: a chat after the restart is answered by the adopted container.

## How to get to it (user POV)

- An operator restarts the service (`sudo systemctl restart nanoclaw-v2` on the live install). On the verify instance, `verify-nanoclaw.sh restart`.

## Driving it with verify-nanoclaw.sh

Preconditions:

- `cli-chat` ran in this run, so the group's container is up.

- **Restart.** Run `verify-nanoclaw.sh restart "$RUN"`. It prints `Reconciled sessions at startup adopted=1 stopped=0 pendingClaim=0`, and `containers-across-restart.txt` names the container.
- **Answer.** Run `verify-nanoclaw.sh chat "$RUN" "verify-proof after restart"`. Exit 0, and `host-restart.log` shows no new `Spawning container` line.

## Gotchas

- Adoption lists containers by the `nanoclaw-install` label only. `guard` must show that the restart touched no live-labelled container.
- A container that is idle long enough is reaped (15 min chat idle). Restart soon after the chat, or the drive reads `adopted=0`.
