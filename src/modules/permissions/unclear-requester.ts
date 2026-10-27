import { REQUESTER_WINDOW_MS, resolveRequester } from '../../caller-identity.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { pickApprover } from '../approvals/primitive.js';

const WHY: Record<'nobody' | 'several' | 'busy' | 'unidentified', string> = {
  several: 'several people wrote in this conversation in the last {m} minutes',
  nobody: 'nobody wrote in this conversation in the last {m} minutes',
  busy: 'too many messages arrived in this conversation in the last {m} minutes to read them all',
  unidentified: 'a message from a sender the host cannot identify arrived in this conversation in the last {m} minutes',
};

export async function requesterOrApproval(
  session: Session,
  action: string,
  payload: Record<string, unknown>,
  wants: string,
  /** The group whose admins can complete this action; null when only owners and global admins can. */
  approverGroupId: string | null,
): Promise<string | null> {
  const requester = await resolveRequester(session);
  if (requester.kind === 'one') return requester.userId;
  const why = WHY[requester.reason].replace('{m}', String(REQUESTER_WINDOW_MS / 60_000));
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const posted = await requestApproval({
    session,
    agentName,
    action,
    payload,
    approvers: await pickApprover(approverGroupId),
    onlyRecipientAnswers: true,
    title: 'Approve this change',
    question: `${agentName} wants to ${wants}. The host can't tell who asked: ${why}. Approving runs it as you.`,
  });
  if (posted) {
    await notifyAgent(
      session,
      `${action} is waiting for an owner or admin to approve it, because ${why} and the host can't tell who asked.`,
    );
  }
  return null;
}
