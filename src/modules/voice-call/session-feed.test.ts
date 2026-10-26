import { describe, expect, it } from 'vitest';

import { notifyOutboundDelivered } from '../../delivery-events.js';
import type { CallRoute } from './registry.js';
import { followSessionFeed, type FeedEvent } from './session-feed.js';

const route: CallRoute = {
  channelType: 'slack-acme',
  instance: 'slack-acme',
  platformId: 'slack:C1',
  threadId: 'slack:C1:111.1',
  messagingGroupId: 'mg-1',
};

const posted = (text: string, extra: { sessionId?: string; inReplyTo?: string; threadId?: string | null } = {}) =>
  notifyOutboundDelivered({
    sessionId: extra.sessionId ?? 'sess-1',
    outboundId: `posted-${text}`,
    inReplyTo: extra.inReplyTo ?? null,
    post: {
      text,
      channelType: route.channelType,
      platformId: route.platformId,
      threadId: extra.threadId === undefined ? route.threadId : extra.threadId,
    },
  });
const ran = (action: string, sessionId = 'sess-1') =>
  notifyOutboundDelivered({ sessionId, outboundId: `ran-${action}`, inReplyTo: null, action });

describe('followSessionFeed', () => {
  it('speaks what delivery posts to the call’s thread, and only that, until closed', () => {
    const seen: FeedEvent[] = [];
    const feed = followSessionFeed('sess-1', route, (e) => seen.push(e));
    posted('Two tests fail.', { inReplyTo: 'voice-call1-1' });
    posted('posted elsewhere', { threadId: 'slack:C1:999.9' });
    posted('another session', { sessionId: 'sess-other' });
    posted('   ');
    ran('turn_end', 'sess-other');
    ran('wiki_admission');
    ran('turn_end');
    expect(seen).toEqual([
      { type: 'reply', text: 'Two tests fail.', inReplyTo: 'voice-call1-1' },
      { type: 'turn-end' },
    ]);

    feed.close();
    posted('after hang-up');
    ran('turn_end');
    expect(seen).toHaveLength(2);
  });
});
