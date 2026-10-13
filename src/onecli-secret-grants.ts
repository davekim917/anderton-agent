import { addWorkgroupOnecliSecret, getAgentGroup } from './db/agent-groups.js';
import { readContainerConfig, updateContainerConfig } from './container-config.js';

export async function declareGroupSecret(agentGroupId: string, secretName: string): Promise<boolean> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return false;
  // `updateContainerConfig` rewrites the file under a lock even when nothing changes; the OAuth refresh calls this.
  if ((readContainerConfig(group.folder).onecliSecrets ?? []).includes(secretName)) return false;
  let added = false;
  await updateContainerConfig(group.folder, (config) => {
    const current = config.onecliSecrets ?? [];
    if (current.includes(secretName)) return;
    config.onecliSecrets = [...current, secretName];
    added = true;
  });
  return added;
}

export interface SecretDeclaration {
  kind: 'workgroup' | 'group';
  id: string;
  added: boolean;
}

/**
 * A new declaration goes on the group's workgroup, so every member gets it (a group in no workgroup declares it
 * itself). One already in the group's container.json stays there: moving it would hand an existing grant to every
 * sibling without anyone asking.
 */
export async function ensureGroupSecretDeclared(agentGroupId: string, secretName: string): Promise<SecretDeclaration> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return { kind: 'group', id: agentGroupId, added: false };
  if ((readContainerConfig(group.folder).onecliSecrets ?? []).includes(secretName)) {
    return { kind: 'group', id: group.id, added: false };
  }
  if (group.workgroup_id) {
    return {
      kind: 'workgroup',
      id: group.workgroup_id,
      added: await addWorkgroupOnecliSecret(group.workgroup_id, secretName),
    };
  }
  return { kind: 'group', id: group.id, added: await declareGroupSecret(group.id, secretName) };
}
