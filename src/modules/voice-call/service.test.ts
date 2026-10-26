import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { h } = vi.hoisted(() => ({
  h: {
    requester: 'slack-acme:U0RAE' as string | null,
    requestThread: 'slack:C1:111.1' as string | null,
    deliveries: [] as Array<{ channelType: string; platformId: string; threadId: string | null; text: string }>,
    writes: [] as Array<{ sessionId: string; content: string; trigger: number; threadId: string | null }>,
    liveClosed: 0,
    sessionLookupFails: false,
    wakeFails: false,
    liveGate: null as Promise<void> | null,
    liveEvent: null as ((event: { type: 'delegation'; id: string; text: string }) => void) | null,
  },
}));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  PREVIEW_ORIGIN_SUFFIX: 'calls.example.test',
  VOICE_CALL_AGENT_GROUPS: new Set(['ag-atlas']),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: async (id: string) => {
    if (h.sessionLookupFails) throw new Error('central DB unavailable');
    return /^sess-\d$/.test(id)
      ? {
          id,
          agent_group_id: 'ag-atlas',
          messaging_group_id: 'mg-thread',
          thread_id: 'slack:C1:111.1',
          agent_provider: null,
        }
      : undefined;
  },
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async () => ({
    id: 'mg-thread',
    channel_type: 'slack-acme',
    instance: 'slack-acme',
    platform_id: 'slack:C1',
  }),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ id: 'ag-atlas', name: 'atlas' }) }));
vi.mock('../../caller-identity.js', () => ({
  deriveHumanRequest: async () =>
    h.requester
      ? { userId: h.requester, route: { channelType: 'slack-acme', platformId: 'slack:C1', threadId: h.requestThread } }
      : null,
}));
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: async () => ({
    id: 'mg-dm',
    channel_type: 'slack-acme',
    instance: 'slack-acme',
    platform_id: 'slack:D0RAE',
  }),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (
      channelType: string,
      platformId: string,
      threadId: string | null,
      _kind: string,
      content: string,
    ) => {
      h.deliveries.push({ channelType, platformId, threadId, text: JSON.parse(content).text });
      return 'ts';
    },
  }),
}));
vi.mock('../../session-manager.js', async (orig) => {
  const real = await orig<typeof import('../../session-manager.js')>();
  const { withCentralSync } = await import('../../db/central-lease.js');
  return {
    SessionWriteRefusedError: real.SessionWriteRefusedError,
    writeSessionMessage: async (
      _ag: string,
      sessionId: string,
      m: { content: string; trigger: number; threadId?: string | null },
      options: { guard?: () => boolean | { ok: false; reason: string } } = {},
    ) => {
      const verdict = options.guard ? await withCentralSync(() => options.guard!(), 'test write guard') : true;
      if (verdict !== true)
        throw new real.SessionWriteRefusedError(verdict === false ? 'guard refused' : verdict.reason);
      h.writes.push({ sessionId, content: m.content, trigger: m.trigger, threadId: m.threadId ?? null });
    },
  };
});
vi.mock('../../request-wake.js', () => ({
  requestWake: async () => {
    if (h.wakeFails) throw new Error('container runtime busy');
    return true;
  },
}));
vi.mock('./session-feed.js', async (orig) => ({
  ...(await orig<typeof import('./session-feed.js')>()),
  followSessionFeed: () => ({ recent: [], close: () => undefined }),
}));
vi.mock('./live.js', async (orig) => ({
  ...(await orig<typeof import('./live.js')>()),
  readCodexLogin: async () => ({ token: 't', accountId: 'a' }),
  openLiveCall: async ({ onEvent }: { onEvent: (event: never) => void }) => {
    h.liveEvent = onEvent as typeof h.liveEvent;
    if (h.liveGate) await h.liveGate;
    return {
      answer: 'v=0 answer',
      context: () => undefined,
      close: () => {
        h.liveClosed += 1;
      },
    };
  },
}));

const { _clearSecretsForTest, registerSecrets } = await import('../../secret-scrubber.js');
const { closeDb, initMigratedTestDb } = await import('../../db/index.js');
const { createUser } = await import('../permissions/db/users.js');
const { grantRole, revokeRole } = await import('../permissions/db/user-roles.js');
const svc = { ...(await import('./service.js')), ...(await import('./registry.js')) };
const { handleVoiceCallRequest } = await import('./http.js');

const linkId = () => /https:\/\/([0-9a-f]{32})\.calls\.example\.test/.exec(h.deliveries[0].text)![1];

let server: http.Server;
let port: number;

function request(id: string, method: string, pathName: string, opts: { origin?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathName,
        headers: {
          host: `${id}.calls.example.test`,
          ...(opts.origin ? { origin: opts.origin } : {}),
          'content-type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

beforeEach(async () => {
  await initMigratedTestDb();
  const at = new Date().toISOString();
  await createUser({ id: 'slack-acme:U0RAE', kind: 'slack-acme', display_name: 'Rae Doe', created_at: at });
  await createUser({ id: 'slack-acme:U0SAM', kind: 'slack-acme', display_name: 'Sam Roe', created_at: at });
  await grantRole({
    user_id: 'slack-acme:U0RAE',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: at,
  });
  h.requester = 'slack-acme:U0RAE';
  h.requestThread = 'slack:C1:111.1';
  h.deliveries = [];
  h.writes = [];
  h.liveClosed = 0;
  h.sessionLookupFails = false;
  h.wakeFails = false;
  h.liveGate = null;
  h.liveEvent = null;
  server = http.createServer((req, res) => {
    const id = (req.headers.host ?? '').split('.')[0];
    if (!handleVoiceCallRequest(id, req, res)) {
      res.writeHead(404);
      res.end('No live preview at this address.');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  svc._resetVoiceCallsForTest();
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('mintVoiceCall', () => {
  it('sends the link to the requester’s DM only, never into the thread', async () => {
    const minted = await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    expect(minted.sentTo).toBe('Rae Doe');
    expect(h.deliveries).toEqual([
      expect.objectContaining({
        platformId: 'slack:D0RAE',
        threadId: null,
        text: expect.stringContaining('Tap to call Atlas'),
      }),
    ]);
    expect(svc.voiceCallHeldUntilMs('sess-1')).toBe(Date.parse(minted.expiresAt));
  });

  it.each([
    ['a group not enabled for calls', { agentGroupId: 'ag-other' }, 'not enabled'],
    ['a non-owner requester during the pilot', { requester: 'slack-acme:U0SAM' }, 'owner only'],
    ['a thread no human has written in', { requester: null }, 'no one to call'],
  ])('refuses %s and sends nothing', async (_name, change, message) => {
    const c = change as { agentGroupId?: string; requester?: string | null };
    if ('requester' in c) h.requester = c.requester ?? null;
    await expect(
      svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: c.agentGroupId ?? 'ag-atlas' }),
    ).rejects.toThrow(message);
    expect(h.deliveries).toEqual([]);
  });

  it('binds the call to the conversation the request came from, not the session default', async () => {
    h.requestThread = 'slack:C1:222.2';
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    expect(svc.getVoiceCall(linkId())?.route).toEqual(
      expect.objectContaining({ channelType: 'slack-acme', platformId: 'slack:C1', threadId: 'slack:C1:222.2' }),
    );
  });

  it('leaves one live link when the same caller asks twice at once', async () => {
    await Promise.all([
      svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' }),
      svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' }),
    ]);
    const ids = h.deliveries.map((d) => /([0-9a-f]{32})/.exec(d.text)![1]);
    expect(ids).toHaveLength(2);
    expect(ids.filter((id) => svc.getVoiceCall(id) !== null)).toHaveLength(1);
  });

  it('replaces an unused link from the same caller in the same thread', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const first = linkId();
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    expect(svc.getVoiceCall(first)).toBeNull();
    expect((await request(first, 'GET', '/')).status).toBe(404);
  });
  it('scrubs registered secrets from what the host posts to Slack', async () => {
    registerSecrets({ FAKE_DOMAIN_SECRET: 'calls.example.test' });
    try {
      await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
      expect(h.deliveries[0].text).toContain('[REDACTED]');
      expect(h.deliveries[0].text).not.toContain('calls.example.test');
    } finally {
      _clearSecretsForTest();
    }
  });
});

describe('the call link', () => {
  it('is claimed by the first offer; after that it serves no page and takes no second offer', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const id = linkId();
    const origin = `https://${id}.calls.example.test`;

    const page = await request(id, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Call Atlas</title>');

    const offer = await request(id, 'POST', '/offer?t=', { origin, body: { sdp: 'v=0 offer' } });
    expect(offer.status).toBe(200);
    const { answer, token } = JSON.parse(offer.body) as { answer: string; token: string };
    expect(answer).toBe('v=0 answer');
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    expect((await request(id, 'POST', '/offer?t=', { origin, body: { sdp: 'v=0 offer' } })).status).toBe(409);
    expect((await request(id, 'GET', '/')).status).toBe(410);
  });

  it('refuses to start a call past the host limit, however many links were sent', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      await svc.mintVoiceCall({ sessionId: `sess-${n}`, agentGroupId: 'ag-atlas' });
      ids.push(/([0-9a-f]{32})/.exec(h.deliveries[h.deliveries.length - 1].text)![1]);
    }
    const offer = (id: string) =>
      request(id, 'POST', '/offer?t=', { origin: `https://${id}.calls.example.test`, body: { sdp: 'v=0 offer' } });
    for (const id of ids.slice(0, 4)) expect((await offer(id)).status).toBe(200);
    const fifth = await offer(ids[4]);
    expect(fifth.status).toBe(409);
    expect(fifth.body).toContain('Too many voice calls');
    expect(svc.getVoiceCall(ids[4])?.state).toBe('ringing');
  });

  it('answers a malformed request target with 400 instead of throwing out of the handler', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const id = linkId();
    expect((await request(id, 'GET', '//[')).status).toBe(400);
    expect((await request(id, 'GET', '/')).status).toBe(200);
  });

  it('refuses a state change from another origin, such as a sibling preview page', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const id = linkId();
    const res = await request(id, 'POST', '/offer?t=', {
      origin: `https://${'f'.repeat(32)}.calls.example.test`,
      body: { sdp: 'v=0 offer' },
    });
    expect(res.status).toBe(403);
    expect(svc.getVoiceCall(id)?.state).toBe('ringing');
  });

  it('needs the claim token to hang up, and hanging up ends the call and frees the container', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const id = linkId();
    const origin = `https://${id}.calls.example.test`;
    const { token } = JSON.parse((await request(id, 'POST', '/offer?t=', { origin, body: { sdp: 'v=0 offer' } })).body);

    expect((await request(id, 'POST', '/hangup?t=wrong', { origin, body: {} })).status).toBe(403);
    expect((await request(id, 'GET', '/events?t=wrong')).status).toBe(403);
    expect(svc.getVoiceCall(id)).not.toBeNull();

    expect((await request(id, 'POST', `/hangup?t=${token}`, { origin, body: {} })).status).toBe(200);
    expect(svc.getVoiceCall(id)).toBeNull();
    expect(h.liveClosed).toBe(1);
    expect(svc.voiceCallHeldUntilMs('sess-1')).toBeNull();
    expect((await request(id, 'GET', '/')).status).toBe(404);
  });

  it('expires unused after the ring window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
      const id = linkId();
      vi.advanceTimersByTime(svc.RING_MS + 1);
      expect(svc.getVoiceCall(id)).toBeNull();
      expect(svc.voiceCallHeldUntilMs('sess-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a claimed call', () => {
  const claim = async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const call = svc.getVoiceCall(linkId())!;
    await svc.answerVoiceCall(call, 'v=0 offer');
    return call;
  };

  it('drops when the page never reports audio after the answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const call = await claim();
      vi.advanceTimersByTime(svc.AUDIO_CONNECT_MS - 1);
      expect(svc.getVoiceCall(call.id)).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(svc.getVoiceCall(call.id)).toBeNull();
      expect(h.liveClosed).toBe(1);
      expect(svc.voiceCallHeldUntilMs('sess-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays up once audio connects, with or without the page’s event stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const call = await claim();
      svc.connectVoiceAudio(call);
      vi.advanceTimersByTime(svc.AUDIO_CONNECT_MS * 5);
      expect(svc.getVoiceCall(call.id)?.state).toBe('live');
      expect(h.liveClosed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the audio clock only when the answer is ready, not while the voice is still connecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let openVoice!: () => void;
      h.liveGate = new Promise<void>((resolve) => (openVoice = resolve));
      await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
      const call = svc.getVoiceCall(linkId())!;
      const answering = svc.answerVoiceCall(call, 'v=0 offer');
      vi.advanceTimersByTime(svc.AUDIO_CONNECT_MS * 2);
      expect(svc.getVoiceCall(call.id)?.state).toBe('connecting');

      openVoice();
      await answering;
      vi.advanceTimersByTime(svc.AUDIO_CONNECT_MS - 1);
      expect(svc.getVoiceCall(call.id)?.state).toBe('live');
      vi.advanceTimersByTime(1);
      expect(svc.getVoiceCall(call.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the voice connection when the call fails after the voice connected', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const call = svc.getVoiceCall(linkId())!;
    h.sessionLookupFails = true;
    await expect(svc.answerVoiceCall(call, 'v=0 offer')).rejects.toThrow('central DB unavailable');
    expect(svc.getVoiceCall(call.id)).toBeNull();
    expect(h.liveClosed).toBe(1);
  });

  it('refuses the claim when the caller is no longer an owner', async () => {
    await svc.mintVoiceCall({ sessionId: 'sess-1', agentGroupId: 'ag-atlas' });
    const call = svc.getVoiceCall(linkId())!;
    await revokeRole('slack-acme:U0RAE', 'owner', null);
    await expect(svc.answerVoiceCall(call, 'v=0 offer')).rejects.toThrow('owner only');
    expect(svc.getVoiceCall(call.id)).toBeNull();
    expect(h.liveClosed).toBe(0);
  });

  it('writes no request once the caller has lost owner, and ends the call', async () => {
    const call = await claim();
    svc.connectVoiceAudio(call);
    await revokeRole('slack-acme:U0RAE', 'owner', null);
    h.liveEvent!({ type: 'delegation', id: 'd1', text: 'Delete the staging bucket.' });
    await vi.waitFor(() => expect(svc.getVoiceCall(call.id)).toBeNull());
    expect(h.writes.some((w) => w.content.includes('staging bucket'))).toBe(false);
    expect(h.deliveries.some((d) => d.text.includes('staging bucket'))).toBe(false);
    expect(h.liveClosed).toBe(1);
  });

  it('ends a live call within a minute of the caller losing owner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const call = await claim();
      svc.connectVoiceAudio(call);
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(svc.getVoiceCall(call.id)?.state).toBe('live');

      await revokeRole('slack-acme:U0RAE', 'owner', null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(svc.getVoiceCall(call.id)).toBeNull();
      expect(h.liveClosed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a live call when the caller check cannot run, rather than keep it open unchecked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const call = await claim();
      svc.connectVoiceAudio(call);
      await closeDb();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(svc.getVoiceCall(call.id)).toBeNull();
      expect(h.liveClosed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a request as delivered once written, even when waking the container fails', async () => {
    const call = await claim();
    svc.connectVoiceAudio(call);
    h.wakeFails = true;
    h.liveEvent!({ type: 'delegation', id: 'd1', text: 'Check the nightly run.' });
    await vi.waitFor(() =>
      expect(h.deliveries.some((d) => d.text.includes('(voice): Check the nightly run.'))).toBe(true),
    );
    expect(h.writes.some((w) => w.content.includes('Check the nightly run.'))).toBe(true);
    expect(svc.getVoiceCall(call.id)?.state).toBe('live');
  });
});
