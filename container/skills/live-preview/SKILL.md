---
name: live-preview
description: >-
  Share a running web app through a live preview link and change it while people watch.
  Use before running `ncl preview open`, whenever someone asks to see an app live or for a
  preview link, and for every change requested while a preview is open, including changes
  that need the backend.
---

# live-preview

## 1. Check where it points before starting anything

Some repos' default dev commands reach production: a frontend API URL baked into the dev
build, a `.env.local` aimed at the production database, a start script that migrates a
deployed database. Before starting the frontend or the backend, read the env files, config
and scripts they will use and resolve:

- the API base URL the frontend will call, including any service address hardcoded in the
  frontend's code, which no env override reaches,
- the backend's database and Redis URLs,
- anything a start script migrates or seeds.

Production is never allowed, and never shared QA or staging for a migration or seed. Override
anything that points there. If the app cannot run without it, stop and say so in the thread.

## 2. Start and share the frontend

Run it from your checkout under `/workspace/worktrees`, listening on `127.0.0.1` (the repo's
preview script if it has one), then `ncl preview open --port <port> --label "<app>"`. Load the
link yourself before posting it.

Viewers' browsers cannot reach the container's `localhost`, so the page must call the backend
through the dev server's own origin (Vite: a `server.proxy` entry for `/api`), never a
`http://localhost:<port>` URL.

## 3. When a change needs the backend

Run the backend here, in watch mode, so backend changes land as fast as frontend ones. Pick its
data stores in this order:

1. **Local**, when the repo's local setup (compose file, dev script, `.env.example`) names
   Postgres or Redis. Start them in this container (below), migrate and seed.
2. **A shared non-production database** (staging, dev project) when the repo has no local
   option, such as hosted Supabase. Code changes only: no migrations, seeds, schema or policy
   changes there; those wait for the PR. Say in the thread that the preview uses staging data.
3. **Production: never.**

**Start the backend with a clean environment**, e.g.
`env -i HOME="$HOME" PATH="$PATH" NODE_ENV=development <repo vars> <start command>`. Your own
environment routes outbound calls through a proxy that adds this group's real credentials; a
backend that inherits it would call real services with them, triggered by anyone holding the
link. With a clean environment, set each outside service (payments, email, push, AI APIs) to
the repo's stub or off mode. A service with no such mode stays unconfigured; say that feature
won't work in the preview. If the backend refuses to boot without a real credential, stop and
ask; don't pass one in. Turn off schedulers, automations and other outbound side effects too,
and check that their switch is actually off: some default to on when unset.

Bind the backend and the data stores to `127.0.0.1`; many backends listen on every interface by
default, which other containers could reach. Never load a seed, dump or fixture that holds real
customer data (real emails, phone numbers, orders): use a synthetic seed, or none.

Then point the frontend's `/api` proxy at `http://127.0.0.1:<backend port>`, and allow the
preview origin if the backend checks CORS.

**Local Postgres and Redis.** Data lives in `/tmp` and disappears with the container, so each
session starts clean and migrates and seeds again.

```bash
PG=/usr/lib/postgresql/15/bin
$PG/initdb -D /tmp/pg -U postgres --auth=trust >/dev/null
$PG/pg_ctl -D /tmp/pg -l /tmp/pg.log start \
  -o "-k /tmp -c listen_addresses=127.0.0.1 -c dynamic_shared_memory_type=mmap"
$PG/createdb -h 127.0.0.1 -U postgres <db name from the repo's env>
redis-server --bind 127.0.0.1 --port 6379 --save '' --daemonize yes
```

Production may run Postgres 16; 15 is fine for app work unless a migration uses a 16-only
feature. If one fails, say so.

**Save what you worked out.** The first session in a repo works out its env overrides, stub
flags and seed command. Save them with `write_memory_file` as
`memory/methods/live-preview-<repo>.md`, including what doesn't work locally, and read that
file first next time. Never commit agent-specific files to the repo itself.

## 4. Close up

Finishing a batch of changes is not ending the session; others may still be using the link.
When someone says to close the preview, run `ncl preview close`, stop the backend and dev
server, and stop Postgres (`$PG/pg_ctl -D /tmp/pg stop`) and Redis (`redis-cli shutdown`). If
"done" could mean either, ask once.
