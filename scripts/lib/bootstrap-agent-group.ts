/** Shared by the single-process agent bootstrap scripts (init-cli-agent, init-first-agent). */
import { DEFAULT_AGENT_PROVIDER } from '../../src/config.js';
import { readContainerConfig, writeContainerConfigScalars } from '../../src/container-config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { ensureContainerConfig } from '../../src/db/container-configs.js';
import { assertValidGroupFolder } from '../../src/group-folder.js';
import type { AgentGroup } from '../../src/types.js';

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The agent group living in `folder`, created with `name` if none does yet. */
export async function findOrCreateAgentGroup(
  folder: string,
  name: string,
  now: string,
): Promise<{ ag: AgentGroup; created: boolean }> {
  assertValidGroupFolder(folder);
  const existing = await getAgentGroupByFolder(folder);
  if (existing) {
    console.log(`Reusing agent group: ${existing.id} (${folder})`);
    return { ag: existing, created: false };
  }
  await createAgentGroup({
    id: generateId('ag'),
    name,
    folder,
    agent_provider: null,
    created_at: now,
  });
  const ag = (await getAgentGroupByFolder(folder))!;
  console.log(`Created agent group: ${ag.id} (${folder})`);
  return { ag, created: true };
}

/**
 * Write a bootstrapped group's provider to both stores, so the container.json the spawn boots and its projection row
 * agree. A new group takes the setup pick, else the install default. A reused group keeps what it boots (container.json,
 * absent meaning Claude): switching an existing group belongs to `ncl groups config update --provider`, which audits
 * pinned tasks first. The projection row is never a source; it can lag the file.
 */
export async function stampGroupProvider(
  ag: AgentGroup,
  created: boolean,
  pickedProvider: string | undefined,
): Promise<void> {
  const provider = (
    created ? (pickedProvider ?? DEFAULT_AGENT_PROVIDER) : (readContainerConfig(ag.folder).provider ?? 'claude')
  ).toLowerCase();
  await ensureContainerConfig(ag.id, provider);
  await writeContainerConfigScalars(ag.id, ag.folder, { provider: provider === 'claude' ? null : provider });
}
