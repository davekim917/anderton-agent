/** A card posted into a thread is easy to miss, so the human who has to answer it also gets a DM linking to it. */
import { deriveHumanRequesterId } from '../../caller-identity.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getPendingApproval } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getUser } from '../permissions/db/users.js';
import { choiceApprovers, getChoiceHandler } from './choices.js';
import { headUnits, pickApprovalDelivery, pickApprover } from './primitive.js';
import { canAnswerApproval } from './response-handler.js';

export type CardPointerOutcome =
  | 'sent-requester'
  | 'sent-approver'
  | 'skipped-not-pending'
  | 'skipped-card-in-dm'
  | 'skipped-no-requester'
  | 'skipped-no-recipient'
  | 'failed';

const MAX_TITLE_UNITS = 150;

/** Called once per posted card, so the pending_approvals row is the dedupe key. */
export async function sendCardPointer(approvalId: string, session: Session): Promise<CardPointerOutcome> {
  try {
    return await pointAtCard(approvalId, session);
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-open is the contract: the card is already posted
  } catch (err) {
    log.warn('Card pointer DM failed', { approvalId, err });
    return 'failed';
  }
}

async function pointAtCard(approvalId: string, session: Session): Promise<CardPointerOutcome> {
  const approval = await getPendingApproval(approvalId);
  if (!approval || approval.status !== 'pending' || !approval.channel_type || !approval.platform_id) {
    return 'skipped-not-pending';
  }
  const cardMg = await getMessagingGroupByPlatform(
    approval.channel_type,
    approval.platform_id,
    approval.instance ?? undefined,
  );
  if (cardMg?.is_group === 0) return 'skipped-card-in-dm';

  const requester = await deriveHumanRequesterId(session);
  if (!requester) {
    log.info('Card pointer DM not sent: no human requester in the session', { approvalId, sessionId: session.id });
    return 'skipped-no-requester';
  }
  const requesterAnswers = await canAnswerApproval(approval, requester);
  const recipients = requesterAnswers ? [requester] : await answerersOf(approval);
  const target = await pickApprovalDelivery(recipients, approval.channel_type, {
    instance: approval.instance ?? undefined,
  });
  if (!target || target.messagingGroup.platform_id === approval.platform_id) {
    log.info('Card pointer DM not sent: no reachable DM for anyone who can answer the card', {
      approvalId,
      requesterAnswers,
    });
    return 'skipped-no-recipient';
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Card pointer DM not sent: delivery adapter unavailable', { approvalId });
    return 'failed';
  }
  const lines = [
    `Your call is needed: ${headUnits(approval.title, MAX_TITLE_UNITS)} — ${whereIs(approval, approval.channel_type, approval.platform_id, cardMg)}`,
  ];
  if (!requesterAnswers) {
    const name = (await getUser(requester))?.display_name || 'The person who asked';
    lines.push(`${name} asked, and can't answer this card.`);
  }
  const dm = target.messagingGroup;
  await adapter.deliver(
    dm.channel_type,
    dm.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({ text: lines.join('\n') }),
    undefined,
    dm.instance ?? dm.channel_type,
  );
  log.info('Card pointer DM sent', { approvalId, recipient: requesterAnswers ? 'requester' : 'approver' });
  return requesterAnswers ? 'sent-requester' : 'sent-approver';
}

async function answerersOf(approval: PendingApproval): Promise<string[]> {
  const named = approval.approver_user_id
    ? [approval.approver_user_id]
    : getChoiceHandler(approval.action)
      ? choiceApprovers(approval)
      : undefined;
  const answerers: string[] = [];
  for (const userId of named ?? (await pickApprover(approval.agent_group_id))) {
    if (await canAnswerApproval(approval, userId)) answerers.push(userId);
  }
  return answerers;
}

function whereIs(
  approval: PendingApproval,
  channelType: string,
  platformId: string,
  cardMg: MessagingGroup | undefined,
): string {
  const adapter = getChannelAdapter(approval.instance ?? channelType);
  const link = approval.platform_message_id
    ? adapter?.messagePermalink?.(platformId, approval.thread_id, approval.platform_message_id)
    : null;
  if (link) return link;
  return cardMg?.name ? `the card is in ${cardMg.name}.` : 'the card is in the thread where it was asked.';
}
