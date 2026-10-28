import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  process.env.PREVIEW_ORIGIN_SUFFIX = 'calls.example';
  process.env.VOICE_CALL_PUBLIC_IP = '203.0.113.7';
  process.env.VOICE_CALL_AGENT_GROUPS = 'ag-test';
  return {
    asker: 'slack-test:U1',
    members: new Set(['U1', 'U2']),
    dms: new Map<string, string>(),
    feed: null as null | ((event: unknown) => void),
    removed: [] as string[],
    roomUp: Promise.resolve() as Promise<void>,
    endless: false,
    room: '',
    roomServiceDown: false,
    deleteDown: false,
    noDm: false,
    offerHold: Promise.resolve() as Promise<void>,
    feedsOpen: 0,
    collectHold: Promise.resolve() as Promise<void>,
    liveFails: false,
    posts: [] as string[],
    slackHold: Promise.resolve() as Promise<void>,
    dmHold: Promise.resolve() as Promise<void>,
    roomStarts: 0,
    stops: 0,
    present: ['p-someone'] as string[],
    live: null as null | ((event: unknown) => void),
    written: [] as Array<{ content: string }>,
  };
});

vi.mock('../../../caller-identity.js', () => ({
  deriveHumanRequest: async () => ({
    userId: H.asker,
    route: { channelType: 'slack-test', platformId: 'slack:C0TEST', threadId: 'slack:C0TEST:1.2' },
  }),
}));
vi.mock('../../../db/sessions.js', () => ({
  getSession: async (id: string) => ({ id, agent_group_id: 'ag-test', messaging_group_id: 'mg-test' }),
}));
vi.mock('../../../db/messaging-groups.js', () => ({
  getMessagingGroup: async () => ({
    id: 'mg-test',
    channel_type: 'slack-test',
    platform_id: 'slack:C0TEST',
    instance: 'slack-test',
  }),
}));
vi.mock('../../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ id: 'ag-test', name: 'Pixel' }) }));
vi.mock('../../../types.js', async (orig) => ({ ...(await orig<object>()), isChannelVariant: () => true }));
vi.mock('../../../db/central-lease.js', () => ({ withCentralSync: async (fn: () => unknown) => fn() }));
vi.mock('../../../channels/slack-lib.js', () => ({
  botTokenKeyForChannelType: () => 'SLACK_BOT_TOKEN_TEST',
  slackCall: async (_token: string, _method: string, body: { cursor?: string; limit: number }) => {
    await H.slackHold;
    const all = [...H.members];
    const at = Number(body.cursor ?? 0);
    if (H.endless) return { ok: true, members: ['UX'], response_metadata: { next_cursor: `${at + 1}` } };
    const next = at + body.limit;
    return {
      ok: true,
      members: all.slice(at, next),
      response_metadata: { next_cursor: next < all.length ? `${next}` : '' },
    };
  },
}));
vi.mock('../../../env.js', async (orig) => ({
  ...(await orig<object>()),
  readEnvFile: () => ({ SLACK_BOT_TOKEN_TEST: 'xoxb-test' }),
}));
vi.mock('../../permissions/user-dm.js', () => ({
  ensureUserDm: async (userId: string) => (H.noDm ? null : { channel_type: 'slack-test', platform_id: `dm:${userId}` }),
}));
vi.mock('../../permissions/db/users.js', () => ({ getUser: async () => ({ display_name: 'Someone' }) }));
vi.mock('../../../session-manager.js', () => ({
  writeSessionMessage: async (_group: string, _session: string, row: { content: string }) => void H.written.push(row),
  SessionWriteRefusedError: class extends Error {},
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: async () => undefined }));
vi.mock('../session-feed.js', () => ({
  followSessionFeed: (_key: unknown, _route: unknown, _prefix: string, onEvent: (event: unknown) => void) => {
    H.feed = onEvent;
    H.feedsOpen += 1;
    return {
      recent: [],
      close() {
        H.feedsOpen -= 1;
      },
    };
  },
  startupContext: () => '',
}));
vi.mock('../service.js', async (orig) => ({
  ...(await orig<object>()),
  mayCall: () => true,
  spokenName: async () => 'Pixel',
  deliverText: async (route: { platformId: string }, text: string) => {
    if (route.platformId.startsWith('dm:')) await H.dmHold;
    if (route.platformId.startsWith('dm:')) H.dms.set(route.platformId.slice(3), text);
    else H.posts.push(text);
  },
}));
vi.mock('../live.js', () => ({
  openLiveCall: async ({ onEvent }: { onEvent: (event: unknown) => void }) => {
    if (H.liveFails) throw new Error('login refused');
    H.live = onEvent;
    return { answer: 'v=0 answer', context() {}, close() {} };
  },
  readCodexLogin: async () => ({ token: 't', accountId: 'a' }),
}));
vi.mock('./livekit.js', () => ({
  groupCallsConfigured: () => true,
  ensureLiveKit: () => {
    H.roomStarts += 1;
    return H.roomUp;
  },
  stopLiveKit: async () => void (H.stops += 1),
  removeLeftoverVoiceContainers: async () => undefined,
  mintToken: (claims: { sub?: string }) => `token-for-${claims.sub}`,
  verifyToken: (token: string) => ({ sub: token.replace('token-for-', ''), video: { room: H.room } }),
  removeParticipant: async (_room: string, identity: string) => {
    if (H.roomServiceDown) throw new Error('room service down');
    H.removed.push(identity);
  },
  deleteRoom: async () => {
    if (H.roomServiceDown || H.deleteDown) throw new Error('room service down');
  },
  liveKitSignalPort: () => 7880,
  LIVEKIT_INTERNAL_URL: 'ws://room:7880',
}));
vi.mock('./bridge-container.js', () => ({
  BridgeBrowser: {
    start: async () => ({
      join: async () => true,
      liveOffer: async () => {
        await H.offerHold;
        return 'v=0 offer';
      },
      liveAnswer: async () => true,
      collect: async () => {
        await H.collectHold;
        return {
          frames: [],
          pieces: [],
          delegations: [],
          slots: {},
          live: 'connected',
          room: 'connected',
          people: H.present,
        };
      },
      stop: async () => undefined,
    }),
  },
}));

const { claimLink, gate, leave, linkFor, listen, startOrJoinGroupCall } = await import('./service.js');
const { getHostShutdownCallbacks } = await import('../../../host-lifecycle.js');

const linkOf = (user: string) => /https:\/\/([0-9a-f]{32})\./.exec(H.dms.get(`slack-test:${user}`) ?? '')![1];

async function until<T>(read: () => T | null | Promise<T | null>, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Status the signaling gate gives this person's pre-connect check: 403 when refused, anything else when admitted. */
function signalStatus(linkId: string, identity: string): Promise<number> {
  return new Promise((resolve) => {
    const res = {
      writeHead(status: number) {
        resolve(status);
        return res;
      },
      end() {},
    };
    const req = { url: `/rtc/validate?access_token=token-for-${identity}`, method: 'GET' };
    gate.handleRequest(linkId, req as never, res as never);
  });
}

async function callWith(...users: string[]) {
  for (const user of users) {
    H.asker = `slack-test:${user}`;
    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
  }
  return Object.fromEntries(users.map((user) => [user, linkOf(user)]));
}

afterEach(async () => {
  for (const shutdown of getHostShutdownCallbacks()) await shutdown();
  H.dms.clear();
  H.removed.length = 0;
  H.roomUp = Promise.resolve();
  H.endless = false;
  H.roomServiceDown = false;
  H.deleteDown = false;
  H.noDm = false;
  H.offerHold = Promise.resolve();
  H.feedsOpen = 0;
  H.collectHold = Promise.resolve();
  H.liveFails = false;
  H.posts.length = 0;
  H.slackHold = Promise.resolve();
  H.dmHold = Promise.resolve();
  H.roomStarts = 0;
  H.stops = 0;
  H.present = ['p-someone'];
  H.feed = null;
  H.live = null;
  H.written.length = 0;
  H.members = new Set(['U1', 'U2']);
});

describe('group calls', () => {
  it('refuses someone who is not in the channel the call starts from', async () => {
    H.asker = 'slack-test:U9';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /people in this channel/,
    );
    expect(H.dms.size).toBe(0);
  });

  it('holds a link opened before the room is up until it is, rather than refusing it', async () => {
    let roomUp!: () => void;
    H.roomUp = new Promise((resolve) => (roomUp = resolve));
    const links = await callWith('U1');
    let settled = false;
    const claim = claimLink(links.U1).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    roomUp();
    expect((await claim)?.token).toBe(`token-for-${linkFor(links.U1)!.person.identity}`);
  });

  it('keeps someone who is already in the room on the call when they are asked about again', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const onCall = linkFor(links.U1)!.person;
    H.present = [onCall.identity];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /already on this call/,
    );
    expect(H.removed).toEqual([]);
    expect(linkFor(links.U1)?.person).toBe(onCall);
  });

  it('sends a new link to someone whose page is gone, and retires the old one', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    H.present = [];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    expect(linkFor(links.U1)).toBeNull();
    expect(linkFor(linkOf('U1'))).not.toBeNull();
  });

  it('re-sends a link during a cold start without trying to remove anyone from a room nobody is in yet', async () => {
    let roomUp!: () => void;
    H.roomUp = new Promise((resolve) => (roomUp = resolve));
    const links = await callWith('U1');
    const early = claimLink(links.U1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    const fresh = linkOf('U1');
    expect(fresh).not.toBe(links.U1);
    roomUp();
    expect(await early).toBeNull();
    expect(H.removed).toEqual([]);
    expect((await until(() => claimLink(fresh))).url).toBe(`wss://${fresh}.calls.example`);
  });

  it('relays only speech that names the agent, even right after the voice spoke', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const live = await until(() => H.live);
    const relayed = (text: string) => H.written.some((row) => row.content.includes(`<request>${text}</request>`));

    live({ type: 'transcript', role: 'voice', text: 'Staging or production? Start your answer with Pixel.' });
    live({ type: 'delegation', id: 'd-1', text: 'Okay, are we still doing lunch at noon' });
    live({ type: 'delegation', id: 'd-2', text: 'Pixel, staging.' });
    await until(() => relayed('Pixel, staging.'));
    expect(relayed('Okay, are we still doing lunch at noon')).toBe(false);
  });

  it('finds a channel member past the first ten pages of a large channel’s member list', async () => {
    H.members = new Set([...Array.from({ length: 12_000 }, (_, i) => `UX${i}`), 'U1']);
    const links = await callWith('U1');
    expect((await until(() => claimLink(links.U1))).url).toBe(`wss://${links.U1}.calls.example`);
  });

  it('refuses rather than loops when the member list never ends', async () => {
    H.endless = true;
    H.asker = 'slack-test:U1';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /could not check who is in this channel/,
    );
  });

  it('refuses a reconnect from someone who has left the channel, before the minute check', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const { call, person } = linkFor(links.U1)!;
    H.room = call.id;
    expect(await signalStatus(links.U1, person.identity)).not.toBe(403);
    H.members = new Set(['U2']);
    expect(await signalStatus(links.U1, person.identity)).toBe(403);
  });

  it('stops the room server when someone could not be removed and the room could not be deleted', async () => {
    const first = await callWith('U1');
    await until(() => claimLink(first.U1));
    H.asker = 'slack-test:U2';
    await startOrJoinGroupCall({ sessionId: 'sess-other', agentGroupId: 'ag-test' });
    const other = linkOf('U2');
    await until(() => claimLink(other));

    H.roomServiceDown = true;
    await leave(first.U1);

    expect(linkFor(other)).toBeNull();
    expect(H.stops).toBeGreaterThan(0);
  }, 15_000);

  it('leaves other calls alone when an ordinary call end cannot delete its room', async () => {
    const first = await callWith('U1');
    await until(() => claimLink(first.U1));

    H.deleteDown = true;
    H.noDm = true;
    H.asker = 'slack-test:U2';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-other', agentGroupId: 'ag-test' })).rejects.toThrow(/DM/);

    expect(linkFor(first.U1)).not.toBeNull();
    expect(H.stops).toBe(0);
  });

  it('leaves no thread feed open when the call ends while its voice is connecting', async () => {
    let connect!: () => void;
    H.offerHold = new Promise((resolve) => (connect = resolve));
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await new Promise((resolve) => setTimeout(resolve, 1300));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(H.feedsOpen).toBe(0);
  });

  it('starts no voice for a call that ended while a poll was reading the room', async () => {
    H.present = [];
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    let answer!: () => void;
    H.collectHold = new Promise((resolve) => (answer = resolve));
    H.present = ['p-someone'];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([H.live, H.feedsOpen]).toEqual([null, 0]);
  });

  it('tells the thread why the call ended when the voice cannot start', async () => {
    H.liveFails = true;
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await until(() => H.posts.find((post) => post.startsWith('📞 Group call ended')));
    expect(H.posts).toContain('📞 Group call ended: The voice could not join the call.');
  });

  it('refuses to add someone to a call that ends while their channel check runs, and sends no link', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    let answer!: () => void;
    H.slackHold = new Promise((resolve) => (answer = resolve));
    H.asker = 'slack-test:U2';
    const adding = startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    answer();
    await expect(adding).rejects.toThrow(/just ended/);
    expect(H.dms.has('slack-test:U2')).toBe(false);
  });

  it('never starts the room for a call that ended while its first link was being sent', async () => {
    let delivered!: () => void;
    H.dmHold = new Promise((resolve) => (delivered = resolve));
    H.asker = 'slack-test:U1';
    const starting = startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    delivered();
    await expect(starting).rejects.toThrow(/ended before it started/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(H.roomStarts).toBe(0);
  });

  it('lets a link join once', async () => {
    const links = await callWith('U1');
    const claim = await until(() => claimLink(links.U1));
    expect(claim.url).toBe(`wss://${links.U1}.calls.example`);
    expect(await claimLink(links.U1)).toBeNull();
  });

  it('ends a removed person’s event stream, and the call no longer reaches them', async () => {
    const links = await callWith('U1', 'U2');
    await until(() => claimLink(links.U1));
    await until(() => claimLink(links.U2));
    const heard: Record<string, unknown[]> = { U1: [], U2: [] };
    listen(linkFor(links.U1)!.person, (event) => heard.U1.push(event));
    const stays = linkFor(links.U2)!.person;
    listen(stays, (event) => heard.U2.push(event));
    await until(() => H.feed);

    await leave(links.U2);
    H.feed!({ type: 'turn-end' });

    expect(H.removed).toHaveLength(1);
    expect(heard.U2).toEqual([{ type: 'ended', text: 'You were removed from the call.' }]);
    expect(heard.U1).toContainEqual({ type: 'status', text: 'Live' });
    const late: unknown[] = [];
    listen(stays, (event) => late.push(event));
    expect(late).toEqual([{ type: 'ended', text: 'You are no longer on this call.' }]);
  });
});
