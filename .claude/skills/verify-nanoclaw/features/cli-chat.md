# CLI chat

A person types into the terminal client and the wired agent answers in the same terminal. This covers the whole message path: the CLI adapter, routing, the session's inbound DB, the container spawn, the provider, the outbound DB and delivery.

## Sub-features

- `chat-first-spawn`: the first message spawns the group's container.
- `chat-reply`: the reply text reaches the client.
- `chat-rows`: inbound and outbound rows and the delivery stamp exist for the exchange.

## How to get to it (user POV)

- `pnpm run chat <message>` in the install's checkout (`scripts/chat.ts`, which connects to `data/cli.sock`).

## Driving it with verify-nanoclaw.sh

Preconditions:

- The baseline from the README.

- **Send.** Run `verify-nanoclaw.sh chat "$RUN" "verify-proof ping <run id>"`. Exit code 0, and stdout starts with `Mock response to:` and contains `<message id="` for the sent message.
- **Rows.** Read `session-db-<n>.txt` for that chat call. `messages_in` has a `chat` row whose text is the message, `messages_out` has a `chat` row with subtext `mock:group-default`, and `delivered` has a row stamped after the send.
- **Container.** Read `container-<name>-<n>.json` and `container-<name>-<n>.mounts.txt`. Label `nanoclaw-install` is the run's slug, the image is `nanoclaw-agent-v2-<slug>:latest`, and every mount source sits under the run's scratch directory.

## Gotchas

- With outcome reporting on (the fleet default), the mock's final text is stored as an internal `work_log` and never reaches the client. The client times out after 120s with exit 3. `seed` turns it off for this reason. The 2026-10-14 run recorded both behaviours.
- `init-cli-agent` writes no `container.json`. Without `seed` the group runs the install's default provider, which needs a real model credential the throwaway OneCLI agent does not have.
- The chat client exits 2s after the first reply, so a slow second reply is missed. Read the outbound rows rather than trusting stdout alone.
