# Claude Code 2.1.302 and Agent SDK 0.3.302 for Haiku 5.5

The container CLI moves so the fleet can run Claude Haiku 5.5: 2.1.290 has no `claude-haiku-5-5` in its model catalog,
and 2.1.302 lists it with adaptive thinking and the full effort ladder. The SDK moves in lockstep. Only changes that
reach a headless SDK session are listed; terminal UI, VS Code, desktop, cloud-session, Claude Tag and Code Review
entries do not run in a container.

## docker:claude-code 2.1.290 → 2.1.302

Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.291 through 2.1.302)

- 2.1.293: adds Claude Haiku 5.5 and makes it the CLI's own default Haiku; the fleet sets the word `haiku` itself through `ANTHROPIC_DEFAULT_HAIKU_MODEL` · test: src/claude-spawn-defaults.test.ts
- 2.1.302: fork subagents (`subagent_type: "fork"`) are on by default in `claude -p` and SDK sessions; the fleet keeps them off with `CLAUDE_CODE_FORK_SUBAGENT=0` in the Claude spawn env · test: src/claude-spawn-defaults.test.ts
- 2.1.292: the Agent tool takes an `effort` parameter for the subagent it starts · not covered: model-chosen; subagent rows record NULL effort (`attachTurnEffort`)
- 2.1.292: one-shot `claude -p` and SDK runs wait for background commands before ending · not covered: the runner keeps its query open across turns and ends it itself
- 2.1.299: ScheduleWakeup fires in SDK sessions while a background task runs · not covered: the runner disallows ScheduleWakeup (`SDK_DISALLOWED_TOOLS`)
- 2.1.299: an approved tool call no longer runs twice when a session resumes after a restart (a 2.1.296 regression the fleet never ran) · not covered: needs a CLI restart mid-approval
- 2.1.302: a subagent's own Agent calls run in the foreground by default in SDK sessions · not covered: subagent scheduling inside the CLI; no fake exercises nested Agent calls
- 2.1.302: an SDK session with no permission mode starts in `default` on third-party providers · not covered: the runner always passes `bypassPermissions` on the first-party API
- 2.1.300: resuming a headless session no longer loses a compaction's kept messages or summary after a cut or retried reply · not covered: needs a real compaction against the API
- 2.1.299: MCP tool calls in headless sessions no longer fail or run twice when a background reconnect closes their connection · not covered: needs a remote MCP server that drops connections
- 2.1.295: remote MCP servers in headless sessions reconnect after a long outage and back off up to 30 s on repeated drops · not covered: needs a remote MCP server that drops connections
- 2.1.299: WebFetch page reads take the caller's effort on the caller's model, else the small model's configured effort · not covered: inside the CLI, no fleet setting changes it
- 2.1.296: token counts for adaptive-only models such as Haiku 5.5 no longer fail behind some gateways · not covered: no gateway in front of the API here
- 2.1.300: agent hooks honour their `model`, and the `haiku` alias resolves · not covered: the fleet configures no agent hooks
- remaining 2.1.291–2.1.302 entries are terminal, IDE, cloud-session, plugin-CLI or third-party-provider fixes · not covered: those surfaces do not run in the container

## @anthropic-ai/claude-agent-sdk, @anthropic-ai/claude-agent-sdk-darwin-arm64, @anthropic-ai/claude-agent-sdk-darwin-x64, @anthropic-ai/claude-agent-sdk-linux-arm64, @anthropic-ai/claude-agent-sdk-linux-arm64-musl, @anthropic-ai/claude-agent-sdk-linux-x64, @anthropic-ai/claude-agent-sdk-linux-x64-musl, @anthropic-ai/claude-agent-sdk-win32-arm64, @anthropic-ai/claude-agent-sdk-win32-x64 0.3.290 → 0.3.302

Source: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (0.3.291 through 0.3.302)

- 0.3.302: fork subagents on by default in SDK sessions (same as the CLI entry above) · test: src/claude-spawn-defaults.test.ts
- 0.3.302: an omitted `permissionMode` starts in `default` on third-party providers · not covered: the runner always sets `permissionMode: 'bypassPermissions'`
- 0.3.302: a refused structured-output response is an error with no payload · not covered: the runner requests no structured output
- 0.3.300: `updatedInput` from a PreToolUse hook is validated like Claude's own input and unknown keys are dropped; the runner's Bash rewrite spreads the original input and changes only `command` · not covered: the rewrite test feeds only `command`, so no test exercises key preservation against the real CLI
- 0.3.300: `thinking: { type: 'disabled' }` runs as adaptive on models that cannot turn thinking off · not covered: the runner sends `thinking: { type: 'adaptive' }`, never `disabled`
- 0.3.301: `setModel()` with a model id succeeds while the account is at a usage limit, and the next message reports the limit · not covered: needs an account at its limit; the runner's live model change calls `setModel`
- 0.3.292: `background_tasks_changed` for a finishing task arrives after its `task_updated` and `task_notification`; the runner handles the three independently · test: container/agent-runner/src/providers/claude.backgroundTasks.test.ts
- 0.3.296: MCP tool descriptions and server instructions sent up front are capped at 4,096 characters, up from 2,048 · not covered: no fleet MCP tool description is near either cap
- 0.3.295: SDK option values are passed to the CLI as `--flag=value` · not covered: argument transport between the SDK and its bundled CLI, versioned together
- 0.3.292–0.3.301: new optional fields on task, rate-limit and tool-result events (`agent_id`, `parent_task_id`, `run_id`, `overageEnabled`, `claude_code_version`) · not covered: additive; the runner reads none of them
