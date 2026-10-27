import { log } from '../../log.js';
import type { ContextChannel, LiveCall, LiveEvent } from './live.js';
import { greeting, voiceCallEndedText, voiceInstructions, voiceRequestText } from './prompts.js';
import { startupContext, type FeedEvent, type SessionFeed } from './session-feed.js';

const OUTPUT_LIMIT_BYTES = 4000;
const SPOKEN_TRANSCRIPT_LIMIT = 8 * 1024;

export interface CallParty {
  agentName: string;
  callerName: string;
}

export interface CallPorts {
  openLive(input: { offer: string; instructions: string; onEvent: (event: LiveEvent) => void }): Promise<LiveCall>;
  feed(onEvent: (event: FeedEvent) => void): SessionFeed;
  /**
   * Writes a message into the call's session as the caller. The id is known before the write lands, so a reply racing
   * the write still finds its request; `wake` false leaves the message as context for the next turn.
   */
  inject(text: string, wake: boolean): { id: string; written: Promise<void> };
  mirror(text: string): void;
  status(text: string): void;
  /** A piece of live transcript for the page's captions; `done` closes that side's line. */
  caption(role: 'caller' | 'voice', text: string, done: boolean): void;
  ended(text: string): void;
}

function truncateMiddle(text: string, limit = OUTPUT_LIMIT_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const half = Math.floor((limit - 20) / 2);
  const head = Buffer.from(text).subarray(0, half).toString('utf8').replace(/�$/, '');
  const tail = Buffer.from(text).subarray(-half).toString('utf8').replace(/^�/, '');
  return `${head}\n…truncated…\n${tail}`;
}

class SpokenTranscript {
  private entries: Array<{ role: 'caller' | 'voice'; text: string }> = [];
  private open = { caller: false, voice: false };

  add(event: LiveEvent): void {
    if (event.type === 'transcript') {
      const last = this.entries[this.entries.length - 1];
      if (this.open[event.role] && last?.role === event.role) last.text += event.text;
      else this.entries.push({ role: event.role, text: event.text });
      this.open[event.role] = true;
    } else if (event.type === 'turn-done') {
      this.open[event.role] = false;
    } else return;
    let size = this.entries.reduce((sum, e) => sum + Buffer.byteLength(e.text) + 8, 0);
    while (size > SPOKEN_TRANSCRIPT_LIMIT && this.entries.length > 1)
      size -= Buffer.byteLength(this.entries.shift()!.text) + 8;
  }

  get callerSpoke(): boolean {
    return this.entries.some((e) => e.role === 'caller' && e.text.trim());
  }

  take(): string {
    const text = this.entries
      .filter((e) => e.text.trim())
      .map((e) => `${e.role === 'caller' ? 'Caller' : 'Voice'}: ${e.text.trim()}`)
      .join('\n');
    this.entries = [];
    this.open = { caller: false, voice: false };
    return text;
  }
}

export class VoiceCallBridge {
  private live: LiveCall | null = null;
  private feed: SessionFeed | null = null;
  private spoken = new SpokenTranscript();
  /** The session message each request became, to the delegation it answers. */
  private requests = new Map<string, string>();
  private active: string | null = null;
  /**
   * Requests answered by a reply in the current turn, and requests whose turn has ended. Only replies retire a request:
   * they arrive in delivery's order with the turn end, while progress is polled on its own clock and can run ahead.
   */
  private inTurn = new Set<string>();
  private done = new Set<string>();
  private beforeLive: Array<[string, ContextChannel, string | undefined]> = [];
  private sentAny = false;
  private connected = false;
  private greeted = false;
  private closed = false;

  constructor(
    private readonly party: CallParty,
    private readonly ports: CallPorts,
  ) {}

  async start(offer: string): Promise<string> {
    this.feed = this.ports.feed((event) => this.onFeed(event));
    const context = startupContext(this.feed.recent, this.party.agentName);
    const instructions =
      voiceInstructions(this.party.agentName, this.party.callerName) + (context ? `\n\n${context}` : '');
    try {
      this.live = await this.ports.openLive({ offer, instructions, onEvent: (event) => this.onLive(event) });
    } catch (err) {
      this.feed.close();
      this.closed = true;
      throw err;
    }
    if (this.closed) {
      this.live.close();
      throw new Error('The call ended while it was connecting.');
    }
    for (const [text, channel, delegationId] of this.beforeLive.splice(0)) this.context(text, channel, delegationId);
    this.ports.mirror(`📞 ${this.party.callerName} started a voice call with ${this.party.agentName}.`);
    return this.live.answer;
  }

  audioConnected(): void {
    this.connected = true;
    this.greet();
  }

  private greet(): void {
    if (this.greeted || !this.connected || !this.live) return;
    this.greeted = true;
    this.context(greeting(this.party.agentName), 'speakable');
  }

  private context(text: string, channel: ContextChannel, delegationId?: string): void {
    if (this.closed) return;
    if (this.live) this.live.context(truncateMiddle(text), channel, delegationId);
    else this.beforeLive.push([text, channel, delegationId]);
  }

  private onLive(event: LiveEvent): void {
    if (this.closed) return;
    if (event.type === 'started') {
      this.greet();
      return;
    }
    if (event.type === 'closed') {
      this.end({ dropped: false, reason: 'The voice service ended the call.' });
      return;
    }
    if (event.type === 'delegation') {
      this.delegate(event.id, event.text);
      return;
    }
    if (event.type === 'transcript') this.ports.caption(event.role, event.text, false);
    else this.ports.caption(event.role, '', true);
    this.spoken.add(event);
  }

  private delegate(id: string, request: string): void {
    const transcript = this.spoken.take();
    if (!request.trim() && !transcript) return;
    const text = voiceRequestText({ callerName: this.party.callerName, request, transcript, first: !this.sentAny });
    this.sentAny = true;
    this.ports.status(`${this.party.agentName} is working…`);
    const injected = this.ports.inject(text, true);
    this.requests.set(injected.id, id);
    injected.written.then(
      () => {
        if (request.trim()) this.ports.mirror(`🎙️ *${this.party.callerName}* (voice): ${request.trim()}`);
      },
      (err: unknown) => {
        log.warn('Voice call: request may not have reached the session', { err });
        this.context(
          `That request may not have reached ${this.party.agentName}. Ask the caller to check the thread before asking again.`,
          'speakable',
          id,
        );
      },
    );
  }

  /** The request a message names: its delegation, `'finished'` once its turn has ended, or null for any other message. */
  private requestNamed(inReplyTo: string | null): string | 'finished' | null {
    const id = inReplyTo ? this.requests.get(inReplyTo) : undefined;
    if (!id) return null;
    return this.done.has(id) ? 'finished' : id;
  }

  private onFeed(event: FeedEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'inbound':
        this.context(`In the thread, ${event.sender}: ${event.text}`, 'commentary');
        return;
      case 'progress': {
        const named = this.requestNamed(event.inReplyTo);
        if (named === 'finished') return;
        const delegation = named ?? this.active;
        if (delegation) this.context(event.text, 'commentary', delegation);
        return;
      }
      case 'reply': {
        const named = this.requestNamed(event.inReplyTo);
        if (named && named !== 'finished') this.active = named;
        const delegation = named === 'finished' ? null : (named ?? this.active);
        if (delegation) {
          this.inTurn.add(delegation);
          this.context(event.text, 'speakable', delegation);
        } else this.context(`${this.party.agentName} posted in the thread: ${event.text}`, 'speakable');
        return;
      }
      case 'turn-end':
        for (const id of this.inTurn) this.done.add(id);
        this.inTurn.clear();
        this.active = null;
        this.ports.status('Live');
        return;
    }
  }

  end({ dropped, reason }: { dropped: boolean; reason: string }): void {
    if (this.closed) return;
    this.closed = true;
    this.live?.close();
    this.feed?.close();
    const leftover = this.spoken.callerSpoke ? this.spoken.take() : '';
    if (leftover || this.sentAny) {
      this.ports
        .inject(voiceCallEndedText(this.party.callerName, leftover, dropped), Boolean(leftover))
        .written.catch((err: unknown) =>
          log.warn('Voice call: the end of the call did not reach the session', { err }),
        );
    }
    this.ports.mirror(`📞 Voice call ${dropped ? 'dropped' : 'ended'}.`);
    this.ports.ended(reason);
  }
}
