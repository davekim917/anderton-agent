---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider opencode`; host materializes provider config and mounts provider state when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The
backend is selected per agent group by the **`provider`** field materialized
from `container_configs` into that group's `container.json`.

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

### Pre-flight

Use the following as an installed-state inventory:

- `src/providers/opencode.ts`
- `src/providers/opencode-registration.test.ts`
- `container/agent-runner/src/providers/opencode.ts`
- `container/agent-runner/src/providers/opencode-registration.test.ts`
- `import './opencode.js';` line in `src/providers/index.ts`
- `import './opencode.js';` line in `container/agent-runner/src/providers/index.ts`
- `@opencode-ai/sdk` in `container/agent-runner/package.json`
- `opencode-ai@${OPENCODE_VERSION}` in the pnpm global-install block in `container/Dockerfile`
- `src/opencode-dockerfile.test.ts`

Whether every item is present or some are missing, continue through the fetched
candidate and composed-tree gates below. An installed provider must not skip
those gates: they are what make reapply safe when the registry branch or shared
memory contract changes. All steps are idempotent.

### 1. Fetch, validate, and create-only install the provider payload

```bash
bash -lc 'set -euo pipefail; source setup/lib/channels-remote.sh; remote=$(resolve_channels_remote); git fetch "$remote" providers; pnpm exec tsx scripts/provider-memory-contract.ts --provider opencode --ref "$remote/providers" --install'
```

The installer reads and validates the complete candidate before writing any
target. It creates missing files and accepts byte-identical existing files, but
fails closed before the first write when an existing provider-owned file
differs from the fetched payload. Treat that difference as a possible local
customization and reconcile it through `/update-nanoclaw`'s full-merge audit;
provider reapply is not permission to overwrite it. For an eligible install,
the installer publishes missing files create-only, leaves identical files
untouched, and validates the composed roster. Because a portable atomic
compare-and-unlink does not exist, a later failure retains any create-only
paths already published and reports them for inspection; it never risks
deleting a concurrent customization. On a stale or differing preflight it
leaves the tree untouched.

### 2. Verify the composed payload

The provider skill plus seven provider-owned source/test paths are create-or-identical copies; a conformant
re-run confirms them, while a stale, partial, or locally differing tree is
never replaced.

```bash
pnpm exec tsx scripts/provider-memory-contract.ts --provider opencode --require-payload
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './opencode.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './opencode.js';
```

### 4. Add `opencode-ai` to the container Dockerfile

Two edits to `container/Dockerfile`, both idempotent:

**(a)** In the "Pin CLI versions" ARG block (around line 45–57), replace any
existing `ARG OPENCODE_VERSION=...` declaration with exactly this line. If no
declaration exists, insert it after `ARG CODEX_VERSION=...`. Never append a
second declaration:

```dockerfile
ARG OPENCODE_VERSION=1.18.34
```

> **Pin to an exact version** — keep host CLI, container CLI, and SDK locked to the same release. `latest` works but caves to upstream cadence; bump deliberately when there's a reason.

**(b)** In the global `pnpm install -g` block that already lists `mermaid-cli`, `@googleworkspace/cli`, and `@openai/codex`, append `"opencode-ai@${OPENCODE_VERSION}"`:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@mermaid-js/mermaid-cli@${MMDC_VERSION}" \
        "@googleworkspace/cli@${GWS_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
        "opencode-ai@${OPENCODE_VERSION}"
```

> If your Dockerfile still has a single combined `pnpm install -g` block for claude-code + agent-browser + vercel (older upstream layout), append `opencode-ai` there instead. Look for the existing layer that installs `@openai/codex` and add OpenCode next to it.

**(c)** Add `opencode-ai` to the `only-built-dependencies` allowlist in `/root/.npmrc`. The container's pnpm is configured to skip postinstall scripts by default; opencode-ai's postinstall downloads its native binary and the CLI errors out at runtime without it ("opencode-ai's postinstall script was not run"). The allowlist is configured in the same `RUN` block that installs vercel (around line 323–328):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    echo "only-built-dependencies[]=@googleworkspace/cli" >> /root/.npmrc && \
    echo "only-built-dependencies[]=opencode-ai" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"
```

> The container `.npmrc` allowlist is **separate** from the host's `pnpm-workspace.yaml` `onlyBuiltDependencies`. The host allowlist is human-gated per CLAUDE.md; this container-side allowlist follows the same posture (only add packages the operator explicitly wants — opencode-ai's postinstall pattern matches the existing entries).

**(d)** Copy the Dockerfile guard into the host test tree and run it. The OpenCode CLI is a globally installed binary, not an importable package, so this structural test is what goes red if the `OPENCODE_VERSION` pin or the `opencode-ai@${OPENCODE_VERSION}` install line is dropped or drifts:

```bash
cp .claude/skills/add-opencode/tests/opencode-dockerfile.test.ts src/opencode-dockerfile.test.ts
pnpm exec vitest run src/opencode-dockerfile.test.ts
```

### 5. Add the agent-runner dependency

Pinned. Derive the SDK version from the exact Docker CLI pin just added; do not
create a second version source or use `bun update`.

```bash
OPENCODE_VERSION="$(pnpm exec tsx -e 'import fs from "node:fs"; import { effectiveDockerArgBeforeFinalRun } from "./setup/lib/dockerfile-version.ts"; const dockerfile = fs.readFileSync("container/Dockerfile", "utf8"); const pin = effectiveDockerArgBeforeFinalRun(dockerfile, "OPENCODE_VERSION", "\"opencode-ai@${OPENCODE_VERSION}\""); if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) process.exit(1); process.stdout.write(pin);')" || exit 1
cd container/agent-runner && bun add @opencode-ai/sdk@"${OPENCODE_VERSION}" && cd -
```

### 6. Build

```bash
pnpm run build                                         # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                   # agent image
```

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If provider files were already present in the build context before, the new files may not be picked up. If you see "Unknown provider: opencode" after the build, prune the builder and rebuild:
>
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

Agent-runner source is not copied per group. The host bind-mounts the one
`container/agent-runner/src` tree read-only at `/app/src` for every container,
so the installed provider source is picked up on the next spawn. Do not create
or mutate retired per-group source overlays.

## Configuration

### Model / provider config (DB, not `.env`)

Model, provider, and effort live in the **`container_configs`** DB row, set via `ncl` — the same one-pattern template claude and codex use (a code-level default, overridden per-group in the DB). The host **no longer reads** `OPENCODE_PROVIDER` / `OPENCODE_MODEL` / `OPENCODE_SMALL_MODEL` / `OPENCODE_EFFORT` from `.env` for model selection (those scoped vars are dead — see `src/providers/opencode.ts`). The provider is **derived from the model slug's prefix** (`deepseek/…` → deepseek, `opencode-go/…` → Go, `opencode/…` → Zen, `nvidia/…` → NVIDIA); there is no base-URL var to set — opencode's provider registry routes by prefix, and the OneCLI gateway injects the credential.

Set the model on the group after selecting `provider=opencode` below (the group
row must exist):

```bash
ncl groups config update --id <agentGroupFolder> --model deepseek/deepseek-chat --effort high
```

If you set nothing, the group inherits the code default `opencode-go/deepseek-v4.1-flash` (effort `high`) — correct for an OpenCode Go group, wrong for any other provider, so a non-Go group **must** set `--model` explicitly. Effort accepts `low|medium|high` (opencode's portable set). The `provider/model-id` shapes in the examples below are still the right FORMAT for `--model` — just pass them to `ncl`, not `.env`.

Credentials: every OpenCode credential lives in the OneCLI vault, registered with the provider's `--host-pattern` (e.g. `api.deepseek.com`, `openrouter.ai`). No `auth.json` is ever staged into a container: OpenCode sends the key `placeholder`, and the gateway replaces it on the way out through `HTTPS_PROXY`. The key never lives in `.env`, on disk, or in the container environment.

Grant a secret through the workgroup or the group, never `onecli agents set-secrets`: each spawn reconciles the agent's grants to exactly what the workgroup and the group's `container.json` declare, so a direct grant is undone at the next spawn.

```bash
ncl secrets grant --name <vault name> --workgroups <workgroup-id>   # every member of the workgroup
ncl secrets grant --name <vault name> --groups <group-id>           # one group (its container.json onecliSecrets)
```

**One OpenCode key per agent.** Secrets whose host pattern is exactly `opencode.ai` (OpenCode Go and Zen) are the exception to the union: the spawn grants exactly one, chosen in this order (`resolveSpawnSecrets`, `src/onecli-secrets.ts`):

1. the group's own, from its `container.json` `onecliSecrets`;
2. else its workgroup's;
3. else the fleet default, `NANOCLAW_OPENCODE_FLEET_SECRET` in `.env` (unset: none).

The losers are withheld and the host logs them. The gateway applies every matching secret and the last header write wins, over vault rows it reads in no defined order, so granting two would pick one at random. Within one level the first declared wins, and a level that lists the fleet secret itself has not declared its own. A new group therefore needs nothing: it inherits its workgroup's key or the fleet default. Give an agent or a workgroup its own account only when it needs separate billing or limits:

```bash
onecli secrets create --name "OpenCode-Go-<label>" --type generic \
  --value YOUR_GO_KEY --host-pattern opencode.ai --path-pattern "/zen/go/*" \
  --header-name "Authorization" --value-format "Bearer {value}"
ncl secrets grant --name "OpenCode-Go-<label>" --groups <group-id>      # or --workgroups <workgroup-id>
```

Each example below gives the `provider/model-id` to pass to `ncl … --model` plus
its OneCLI credential registration. **Nothing about the model goes in `.env`.**

#### Example: DeepSeek

Model id for `--model`: `deepseek/deepseek-chat`. Register the key:

```bash
onecli secrets create --name "DeepSeek" --type generic \
  --value YOUR_KEY --host-pattern "api.deepseek.com" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: OpenRouter

Model id for `--model`: `openrouter/anthropic/claude-sonnet-4`. Register the key:

```bash
onecli secrets create --name "OpenRouter" --type generic \
  --value YOUR_KEY --host-pattern "openrouter.ai" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: Anthropic

Model id for `--model`: `anthropic/claude-sonnet-4-20250514`. OpenCode's
Anthropic SDK sends the key as `x-api-key`, so an `anthropic/*` model needs an
Anthropic **API key** in the vault, registered with `--type anthropic`: the
gateway sets `x-api-key` for an `sk-ant-api…` value. A Claude subscription
OAuth token (`sk-ant-oat…`) does not work here: the gateway only replaces an
`Authorization` header, which this SDK never sends, so the request leaves with
the placeholder and fails with 401.

On a host that runs Claude on a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`),
every container takes `api.anthropic.com` off the proxy so Claude's own
token rotation works, and the gateway then never sees OpenCode's Anthropic
calls. The runner refuses an `anthropic/*` model there with an error naming
the bypass; use one only on a host without that token.

```bash
onecli secrets create --name "Anthropic-API-<label>" --type anthropic \
  --value YOUR_SK_ANT_API_KEY --host-pattern api.anthropic.com
ncl secrets grant --name "Anthropic-API-<label>" --groups <group-id>
```

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API (e.g. `POST …/zen/v1/messages`) expects the key in the **`x-api-key`** header. If OneCLI injects **`Authorization: Bearer …`** only, Zen often returns **401 / "Missing API key"** even though the gateway is working.

**Naming:** NanoClaw's group config **`provider=opencode`** means "run the
**OpenCode agent provider**." Separately, the **`opencode`** prefix in a model
slug is OpenCode's **Zen provider id** — the host derives the routing provider
from the slug prefix (see [Zen docs](https://opencode.ai/docs/zen/)).

Model id for `--model`: an `opencode/<id>` slug, e.g. `opencode/big-pickle` (use a real Zen model id from the docs).

A Zen secret is also an `opencode.ai` secret, so it competes with the Go key
under the one-key rule above: grant it to the group that runs Zen, where it
replaces the workgroup's Go key.

**OneCLI:** register the Zen key with **`x-api-key`**, not Bearer:

```bash
onecli secrets create --name "OpenCode Zen" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

### OpenCode Go (the default provider)

The code default model is an `opencode-go/*` slug. OpenCode Go takes the key as
`Authorization: Bearer`, and OpenCode sends the `x-opencode-session` header on
its own for every `opencode*` provider. The path pattern must cover the path
the pinned CLI calls; the pinned build calls `/zen/go/v1/…`:

```bash
onecli secrets create --name "OpenCode-Go" --type generic \
  --value YOUR_GO_KEY --host-pattern opencode.ai --path-pattern "/zen/go/*" \
  --header-name "Authorization" --value-format "Bearer {value}"
ncl secrets grant --name OpenCode-Go --workgroups <workgroup-id>   # or set NANOCLAW_OPENCODE_FLEET_SECRET=OpenCode-Go
```

models.dev already lists Go under `/inference/go/…`; a CLI bump that follows
it sends Go calls past this pattern with the placeholder, so re-check the path
in the gateway log (`docker logs onecli | grep opencode.ai`) on every
`OPENCODE_VERSION` bump.

Every container gets it, not only OpenCode groups: Claude and Codex
containers carry a headless `opencode` whose staged config names the same
default model and placeholder key.

### Per group

Make sure the group's workgroup (or the fleet default) grants an OpenCode key
as above, then select OpenCode through the container-config source of truth,
then restart the
group so the host materializes the new `provider` into `container.json` and
spawns with the matching host contribution:

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups restart --id <group-id>
```

Do not hand-edit `groups/<folder>/container.json` or legacy
`agent_groups.agent_provider` fields.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation passes through whatever opaque id OpenCode hands back; stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see session-not-found errors after an accidental CLI version mismatch, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)\_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@opencode-ai/sdk" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q "opencode-ai@" container/Dockerfile && echo "Dockerfile install: OK"
pnpm exec vitest run src/providers/opencode-registration.test.ts
pnpm exec vitest run src/opencode-dockerfile.test.ts
cd container/agent-runner && bun run test src/providers/ && cd -
pnpm exec tsx scripts/provider-memory-contract.ts --provider opencode --require-payload
```
