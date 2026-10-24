# OpenCode credentials move to the OneCLI vault

OpenCode containers, and the headless `opencode` in every Claude and Codex container, no longer receive an
`auth.json`. OpenCode sends the key `placeholder` and the OneCLI gateway replaces it with the vault secret for the
request's host. The per-group `~/.local/share/opencode-<folder>/auth.json` files are no longer read.

## Detect

You are affected if any OpenCode group, or any agent that runs `opencode` headless, relied on a scoped file:

```bash
ls ~/.local/share/opencode-*/auth.json 2>/dev/null
```

Then check that a vault secret on `opencode.ai` reaches each group (by name; values are never listed):

```bash
onecli secrets list | jq -r '.data[] | select(.hostPattern=="opencode.ai") | "\(.name)\t\(.pathPattern)"'
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, onecli_secrets FROM workgroups"
grep -E '^NANOCLAW_OPENCODE_FLEET_SECRET=' .env
```

A group with no OpenCode secret at its own level, its workgroup's, or the fleet default sends its OpenCode requests
with the placeholder and gets 401.

## Why

The scoped files had to be created by hand for every new group, and a file staged into a container is a credential the
agent can read. The vault keeps the key out of the container entirely and lets a grant, not a file, decide which
account an agent uses.

## Fix

1. Create the Go key in the vault, if it is not there yet:

   ```bash
   onecli secrets create --name "OpenCode-Go" --type generic \
     --value YOUR_GO_KEY --host-pattern opencode.ai --path-pattern "/zen/go/*" \
     --header-name "Authorization" --value-format "Bearer {value}"
   ```

2. Grant it, either per workgroup (`ncl secrets grant --name OpenCode-Go --workgroups <id>`) or once for the fleet:
   `NANOCLAW_OPENCODE_FLEET_SECRET=OpenCode-Go` in `.env`. A fleet value that is not a vault secret on `opencode.ai`
   is ignored with an error in the host log. Once it is set, every spawn reconciles the agent's grants, so a group
   that declared no secrets before loses any grant made by hand with `onecli agents set-secrets`.
3. A group that used its own OpenCode account gets its own secret, granted to the group:
   `ncl secrets grant --name <its secret> --groups <group-id>`. The spawn grants exactly one `opencode.ai` secret per
   agent: the group's own, else the workgroup's, else the fleet default.
4. An `anthropic/*` OpenCode model needs an Anthropic API key (`sk-ant-api…`) registered with `--type anthropic` on
   `api.anthropic.com` and granted to that group. A Claude subscription token does not work for OpenCode, and on a
   host that sets `CLAUDE_CODE_OAUTH_TOKEN` the runner refuses `anthropic/*` outright: that host takes
   `api.anthropic.com` off the proxy in every container, so the gateway never sees the call.
5. Restart the host. Once Verify passes, delete the scoped files. A directory that still holds an `auth.json` is skipped
   by the agent and skill mirror, so its `agent/` and `skill/` copies stop updating until the file is gone:

   ```bash
   rm ~/.local/share/opencode-*/auth.json
   ```

## Verify

After a group's next turn, the gateway log shows its OpenCode calls authenticated:

```bash
docker logs --since 10m onecli 2>&1 | grep 'opencode.ai' | grep -o 'url=[^ ]* status=[0-9]*' | tail
```

`status=200` on `/zen/go/v1/chat/completions` is the pass. `status=401` means no granted secret matched that path.

## Rollback

Revert the change and restart the host. Rollback needs the scoped files: keep them until the new route is verified,
or recreate each with `opencode providers login` under a throwaway `XDG_DATA_HOME`.
