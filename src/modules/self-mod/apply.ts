/**
 * Guarded handler bodies for self-modification actions.
 *
 * The delivery registry's guard wrapper runs these only on `allow` — which,
 * for self-mod, means an approved replay carrying a valid grant (the
 * decision holds unconditionally from the container path; see ./guard.ts).
 * Each body mutates the container config in the DB, rebuilds/kills the
 * container as needed, and writes an on_wake message so the fresh container
 * picks up where the old one left off.
 *
 * install_packages: update DB + rebuild image + kill container + on_wake.
 * add_mcp_server: update DB + kill container + on_wake.
 */
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getDenialFor } from '../../db/denied-models.js';
import { getSession } from '../../db/sessions.js';
import { isOpenCodeModelSlug } from '../../flag-parser.js';
import {
  assertMcpServerNotPluginOwned,
  isOneCliPlaceholder,
  parseMcpServerConfig,
  readContainerConfig,
  resolveGroupProvider,
  type ParsedMcpServerConfig,
  validateMcpServerName,
  writeContainerConfigJson,
  writeContainerConfigScalars,
} from '../../container-config.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent, type ApprovalHandler } from '../approvals/index.js';

/** Read by the respawned container on its first poll (on_wake), after the kill that applies the change. */
async function writeOnWakeNote(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    onWake: 1,
  });
}

/** Per group, so an install's image always includes the packages an earlier install recorded. */
const installChains = new Map<string, Promise<void>>();

export async function applyInstallPackages(payload: Record<string, unknown>, session: Session): Promise<void> {
  const previous = installChains.get(session.agent_group_id) ?? Promise.resolve();
  const run = previous.then(() => installPackagesNow(payload, session));
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  installChains.set(session.agent_group_id, settled);
  void settled.then(() => {
    if (installChains.get(session.agent_group_id) === settled) installChains.delete(session.agent_group_id);
  });
  return run;
}

/**
 * Called only after the image built with these packages: merged into the lists as they are now, so a failed build
 * stores nothing and a change another writer saved during the build is kept.
 */
async function recordInstalledPackages(
  agentGroupId: string,
  folder: string,
  adding: { apt: string[]; npm: string[] },
): Promise<void> {
  await writeContainerConfigJson(agentGroupId, folder, ({ packages }) => {
    packages.apt = [...new Set([...packages.apt, ...adding.apt])];
    packages.npm = [...new Set([...packages.npm, ...adding.npm])];
  });
}

async function installPackagesNow(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'install_packages approved but agent group missing.');
    return;
  }

  const configRow = await getContainerConfig(agentGroup.id);
  if (!configRow) {
    await notifyAgent(session, 'install_packages approved but container config missing.');
    return;
  }

  const requested = (add: unknown) => (add as string[] | undefined) ?? [];
  const adding = { apt: requested(payload.apt), npm: requested(payload.npm) };
  const pkgs = [...adding.apt, ...adding.npm].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id });
  try {
    await buildAgentGroupImage(session.agent_group_id, adding);
  } catch (e) {
    // Not awaited: a rejection here could leave the approval row clickable, risking a second rebuild.
    void Promise.resolve(
      notifyAgent(
        session,
        `Rebuild failed, so the packages (${pkgs}) were not installed and the config is unchanged: ${e instanceof Error ? e.message : String(e)}. Tell the user; request the install again once the cause is fixed.`,
      ),
    ).catch((err) =>
      log.warn('install_packages failure notification failed', { err, agentGroupId: session.agent_group_id }),
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
    return;
  }
  await recordInstalledPackages(agentGroup.id, agentGroup.folder, adding);
  try {
    await writeOnWakeNote(
      session,
      `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
    );
    killContainer(
      session.id,
      'rebuild applied',
      async () => {
        const s = await getSession(session.id);
        if (s) {
          void requestWake(s, 'self-mod-apply').catch((err) =>
            log.error('Failed to wake container after install_packages rebuild', { err, sessionId: session.id }),
          );
        }
      },
      'respawn_after_stop',
    );
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    log.error('Packages installed but the agent could not be told or restarted', {
      agentGroupId: session.agent_group_id,
      err: e,
    });
  }
}

export async function applyAddMcpServer(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'add_mcp_server approved but agent group missing.');
    return;
  }

  const configRow = await getContainerConfig(agentGroup.id);
  if (!configRow) {
    await notifyAgent(session, 'add_mcp_server approved but container config missing.');
    return;
  }

  // Re-validated here: the last gate before a config the container will load.
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (!name) {
    await notifyAgent(session, 'add_mcp_server approved but server name is missing.').catch((err) =>
      log.warn('Failed to notify agent about rejected add_mcp_server approval', {
        err,
        agentGroupId: session.agent_group_id,
      }),
    );
    return;
  }
  let serverConfig: ParsedMcpServerConfig;
  try {
    validateMcpServerName(name);
    serverConfig = parseMcpServerConfig(payload);
    // eslint-disable-next-line no-catch-all/no-catch-all -- approval payload validation must fail closed
  } catch (err) {
    await notifyAgent(
      session,
      `add_mcp_server approved but config is invalid: ${err instanceof Error ? err.message : String(err)}.`,
    ).catch((notifyErr) =>
      log.warn('Failed to notify agent about rejected add_mcp_server approval', {
        err: notifyErr,
        agentGroupId: session.agent_group_id,
      }),
    );
    return;
  }

  // Dual-write as the CLI does: the spawn reads the FILE, `groups config get`
  // reads the DB. A plugin-owned server is refused before either is touched.
  try {
    assertMcpServerNotPluginOwned(readContainerConfig(agentGroup.folder).mcpServers?.[name], name, agentGroup.folder);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the refusal is the outcome; the notification is best-effort
  } catch (err) {
    // A rejected notify must not throw, or the refused approval stays re-clickable.
    await notifyAgent(session, `add_mcp_server refused: ${err instanceof Error ? err.message : String(err)}`).catch(
      (notifyErr) =>
        log.warn('Failed to notify agent about refused add_mcp_server approval', {
          err: notifyErr,
          agentGroupId: session.agent_group_id,
        }),
    );
    return;
  }

  await writeContainerConfigJson(agentGroup.id, agentGroup.folder, (config) => {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[name] = serverConfig;
  });

  // Keyed on the placeholder VALUE, not header presence: a server with only
  // `Content-Type` has no credential to assign.
  const needsCredential =
    serverConfig.type === 'http' && Object.values(serverConfig.headers ?? {}).some(isOneCliPlaceholder);

  await writeOnWakeNote(
    session,
    `MCP server "${name}" added. Verify it's available (e.g. list your tools) and report the result to the user.` +
      (needsCredential
        ? " It authenticates through the OneCLI gateway: if calls come back 401, one likely cause is that the credential exists but is not assigned to this agent group — grant it with `ncl secrets grant --name <vault name>` (your workgroup by default; it waits for admin approval). A 401 can also mean an expired or incorrect secret, a missing gateway rule, or an authentication scheme the server doesn't accept."
        : ''),
  );
  killContainer(
    session.id,
    'mcp server added',
    async () => {
      const s = await getSession(session.id);
      if (s) {
        void requestWake(s, 'self-mod-apply').catch((err) =>
          log.error('Failed to wake container after add_mcp_server', { err, sessionId: session.id }),
        );
      }
    },
    'respawn_after_stop',
  );
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id });
}

/**
 * No admin approval: the operator deny list is the only guardrail, re-checked
 * here because a denial may land between request and apply.
 */
export async function performModelChange(
  session: Session,
  slug: string,
  effort: string | null,
  notify: (message: string) => void | Promise<void>,
  logContext: Record<string, unknown> = {},
): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notify('change_model failed: agent group missing.');
    return;
  }
  const config = await getContainerConfig(agentGroup.id);
  if (!config) {
    await notify('change_model failed: container config missing.');
    return;
  }
  // The file, not the projection: it is what the respawned container boots.
  const provider = await resolveGroupProvider(agentGroup.id);

  // Opencode slugs MUST be provider-prefixed: the host derives the routing
  // provider from the prefix, and a bare slug restarts into an unresolvable model.
  if (provider === 'opencode' && !isOpenCodeModelSlug(slug)) {
    await notify(
      `change_model failed: "${slug}" is not a valid opencode slug — it must be provider-prefixed ` +
        `(e.g. opencode-go/kimi-k2.7-code, nvidia/meta/llama-3.3-70b-instruct). Run list_models for exact ids.`,
    );
    return;
  }

  const denied = await getDenialFor(provider, slug);
  if (denied) {
    await notify(
      `change_model failed: "${slug}" is in the ${provider} deny list${
        denied.reason ? ` (${denied.reason})` : ''
      }. Aborted.`,
    );
    return;
  }

  await writeContainerConfigScalars(agentGroup.id, agentGroup.folder, { model: slug, effort: effort || undefined });

  log.info('Model change applied', {
    agentGroupId: session.agent_group_id,
    ...logContext,
    previousModel: config.model,
    newModel: slug,
    effort,
  });

  await writeOnWakeNote(
    session,
    `Model changed to "${slug}"${effort ? ` (effort: ${effort})` : ''}. Container has restarted on the new model. ` +
      `Briefly confirm what model you're now running, then continue the work.`,
  );

  killContainer(
    session.id,
    'model changed',
    async () => {
      const s = await getSession(session.id);
      if (s) {
        void requestWake(s, 'self-mod-apply').catch((err) =>
          log.error('Failed to wake container after model change', { err, sessionId: session.id }),
        );
      }
    },
    'respawn_after_stop',
  );
}

/** Approval-path wrapper for change_model approval rows; new requests do not create them. */
export const applyChangeModel: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  await performModelChange(session, payload.slug as string, payload.effort as string | null, notify, { userId });
};
