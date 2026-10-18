/**
 * The one place a card click (question id, chosen value, clicker, clicked message id) becomes a `ResponsePayload`, so
 * every adapter's clicks reach `dispatch` in the same shape. A real function so tests exercise the production
 * construction: `messageId` is optional on the payload, so dropping it here would compile and pass a hand-built test
 * while every real click lost the binding the approvals handler requires (see
 * src/modules/approvals/click-binding.test.ts).
 */
import { log } from '../log.js';
import type { ResponsePayload } from '../response-registry.js';
import type { ChannelSetup } from './adapter.js';

function actionResponsePayload(
  channelType: string,
  questionId: string,
  selectedOption: string,
  userId: string,
  messageId: string | null,
  replyToClicker: ((text: string) => Promise<void>) | undefined,
): ResponsePayload {
  return {
    questionId,
    value: selectedOption,
    userId,
    channelType,
    // Not surfaced by the onAction signature; handlers look them up from the pending_question / pending_approval row.
    platformId: '',
    threadId: null,
    // Approvals bind the click to this message.
    messageId,
    ...(replyToClicker ? { replyToClicker } : {}),
  };
}

/** Builds the payload and dispatches it; never throws at the adapter. */
export function makeOnAction(
  channelType: string,
  dispatch: (payload: ResponsePayload) => Promise<void>,
): ChannelSetup['onAction'] {
  return (questionId, selectedOption, userId, messageId, replyToClicker) => {
    dispatch(actionResponsePayload(channelType, questionId, selectedOption, userId, messageId, replyToClicker)).catch(
      (err) => {
        log.error('Failed to handle question response', { questionId, err });
      },
    );
  };
}
