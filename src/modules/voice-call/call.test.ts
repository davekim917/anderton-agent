import { describe, expect, it } from 'vitest';

import { VoiceCallBridge, type CallPorts } from './call.js';
import type { ContextChannel, LiveEvent } from './live.js';
import type { FeedEvent } from './session-feed.js';

interface Harness {
  bridge: VoiceCallBridge;
  live: (event: LiveEvent) => void;
  agent: (event: FeedEvent) => void;
  appended: Array<{ text: string; channel: ContextChannel; delegationId?: string }>;
  injected: Array<{ text: string; wake: boolean }>;
  mirrored: string[];
  ended: string[];
  instructions: string;
  liveClosed: boolean;
  written: Promise<void>;
}

async function connect(): Promise<Harness> {
  const h = {
    appended: [],
    injected: [],
    mirrored: [],
    ended: [],
    instructions: '',
    liveClosed: false,
    written: Promise.resolve(),
  } as unknown as Harness;
  const ports: CallPorts = {
    openLive: async ({ instructions, onEvent }) => {
      h.instructions = instructions;
      h.live = onEvent;
      return {
        answer: 'v=0 answer',
        context: (text, channel, delegationId) => h.appended.push({ text, channel, delegationId }),
        close: () => {
          h.liveClosed = true;
        },
      };
    },
    feed: (onEvent) => {
      h.agent = onEvent;
      return { close: () => undefined };
    },
    inject: (text, wake) => {
      h.injected.push({ text, wake });
      return { id: `m${h.injected.length}`, written: h.written };
    },
    mirror: (text) => h.mirrored.push(text),
    status: () => undefined,
    ended: (text) => h.ended.push(text),
  };
  h.bridge = new VoiceCallBridge({ agentName: 'Atlas', callerName: 'Rae Doe' }, ports);
  expect(await h.bridge.start('v=0 offer')).toBe('v=0 answer');
  return h;
}

const say = (h: Harness, text: string) => {
  h.live({ type: 'transcript', role: 'caller', text });
  h.live({ type: 'turn-done', role: 'caller', transcript: text });
};

describe('VoiceCallBridge', () => {
  it('greets only once the voice is up and the caller can hear it', async () => {
    const h = await connect();
    h.live({ type: 'started' });
    expect(h.appended).toEqual([]);
    h.bridge.audioConnected();
    h.live({ type: 'started' });
    expect(h.appended).toEqual([
      {
        text: expect.stringContaining('"Hi, it\'s Atlas. What can I do?"'),
        channel: 'speakable',
        delegationId: undefined,
      },
    ]);
  });

  it('keeps what the agent sends while the call is still connecting, in order', async () => {
    const h = { appended: [] as Array<{ text: string }> } as unknown as Harness;
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    let agent!: (event: FeedEvent) => void;
    const bridge = new VoiceCallBridge(
      { agentName: 'Atlas', callerName: 'Rae Doe' },
      {
        openLive: async () => {
          await opened;
          return {
            answer: 'v=0 answer',
            context: (text) => h.appended.push({ text } as never),
            close: () => undefined,
          };
        },
        feed: (onEvent) => {
          agent = onEvent;
          return { close: () => undefined };
        },
        inject: () => ({ id: 'm1', written: Promise.resolve() }),
        mirror: () => undefined,
        status: () => undefined,
        ended: () => undefined,
      },
    );
    const started = bridge.start('v=0 offer');
    agent({ type: 'reply', text: 'first', inReplyTo: null });
    agent({ type: 'reply', text: 'second', inReplyTo: null });
    release();
    await started;
    agent({ type: 'reply', text: 'third', inReplyTo: null });
    expect(h.appended.map((a) => a.text)).toEqual([
      'Atlas posted in the thread: first',
      'Atlas posted in the thread: second',
      'Atlas posted in the thread: third',
    ]);
  });

  it('sends a delegated request with what was said, and mirrors it into the thread', async () => {
    const h = await connect();
    say(h, 'can you check if the tests pass');
    h.live({ type: 'delegation', id: 'd1', text: 'Check whether the tests pass.' });
    say(h, 'and the lint too');
    h.live({ type: 'delegation', id: 'd2', text: 'Also check lint.' });

    expect(h.injected).toHaveLength(2);
    expect(h.injected[0].wake).toBe(true);
    expect(h.injected[0].text).toContain('[Voice call] Rae Doe started a live voice call');
    expect(h.injected[0].text).toContain('<request>Check whether the tests pass.</request>');
    expect(h.injected[0].text).toContain('Caller: can you check if the tests pass');
    expect(h.injected[1].text).toMatch(/^\[Voice call\] Rae Doe, on the live call:/);
    expect(h.injected[1].text).toContain('Caller: and the lint too');
    expect(h.injected[1].text).not.toContain('can you check if the tests pass');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.mirrored).toContain('🎙️ *Rae Doe* (voice): Check whether the tests pass.');
  });

  it('mirrors a request into the thread only once the session has taken it', async () => {
    const h = await connect();
    h.written = new Promise(() => undefined);
    h.live({ type: 'delegation', id: 'd1', text: 'Delete the staging bucket.' });
    h.written = Promise.reject(new Error('refused'));
    h.written.catch(() => undefined);
    h.live({ type: 'delegation', id: 'd2', text: 'Rotate the deploy key.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.mirrored.filter((m) => m.startsWith('🎙️'))).toEqual([]);
    expect(h.appended.map((a) => a.text)).toContain('That request did not reach Atlas. Ask the caller to try again.');
  });

  it('ties the agent’s replies to the request they answer, then releases it at turn end', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'reply', text: 'Also, the nightly is green.', inReplyTo: 'other-message' });

    expect(h.appended).toEqual([
      { text: 'Two tests fail.', channel: 'speakable', delegationId: 'd1' },
      {
        text: 'Atlas posted in the thread: Also, the nightly is green.',
        channel: 'speakable',
        delegationId: undefined,
      },
    ]);
  });

  it('matches a reply to its request even when the reply lands before the write settles', async () => {
    const h = await connect();
    h.written = new Promise(() => undefined);
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    expect(h.appended).toEqual([{ text: 'Two tests fail.', channel: 'speakable', delegationId: 'd1' }]);
  });

  it('answers the request a reply names, even while an earlier one is still being answered', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.live({ type: 'delegation', id: 'd2', text: 'Also check lint.' });
    h.agent({ type: 'reply', text: 'Tests are running.', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Lint is clean.', inReplyTo: 'm2' });
    h.agent({ type: 'reply', text: 'Tests pass too.', inReplyTo: 'unknown' });
    expect(h.appended.map((a) => [a.text, a.delegationId])).toEqual([
      ['Tests are running.', 'd1'],
      ['Lint is clean.', 'd2'],
      ['Tests pass too.', 'd2'],
    ]);
  });

  it('keeps taking requests however the agent batches them', async () => {
    const h = await connect();
    for (let i = 1; i <= 9; i++) {
      h.live({ type: 'delegation', id: `d${i}`, text: `request ${i}` });
      h.agent({ type: 'reply', text: `done ${i}`, inReplyTo: `typed-${i}` });
      h.agent({ type: 'turn-end' });
    }
    expect(h.injected).toHaveLength(9);
  });

  it('on hang-up, wakes the agent with what was said after the last request', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    say(h, 'oh and open a PR when done');
    h.bridge.end({ dropped: false, reason: 'Call ended.' });

    expect(h.liveClosed).toBe(true);
    expect(h.injected[1]).toEqual({ text: expect.stringContaining('Caller: oh and open a PR when done'), wake: true });
    expect(h.injected[1].text).toContain('Rae Doe ended the voice call.');
    expect(h.mirrored[h.mirrored.length - 1]).toBe('📞 Voice call ended.');
    expect(h.ended).toEqual(['Call ended.']);
  });

  it('on hang-up with nothing new said, leaves the end note as context without waking the agent', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.bridge.end({ dropped: true, reason: 'The call dropped.' });
    expect(h.injected[1]).toEqual({
      text: expect.stringContaining('The voice call with Rae Doe dropped.'),
      wake: false,
    });
  });

  it('sends the agent nothing for a call where nothing was asked or said', async () => {
    const h = await connect();
    h.bridge.end({ dropped: false, reason: 'Call ended.' });
    h.live({ type: 'delegation', id: 'late', text: 'too late' });
    expect(h.injected).toEqual([]);
  });

  it('ends when the voice service closes the call', async () => {
    const h = await connect();
    h.live({ type: 'closed', reason: null });
    expect(h.ended).toEqual(['The voice service ended the call.']);
  });
});
