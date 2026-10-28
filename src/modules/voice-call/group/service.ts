import { randomBytes } from 'crypto';

import { botTokenKeyForChannelType, slackRead } from '../../../channels/slack-lib.js';
import { extractSlackChannelId } from '../../../channels/slack.js';
import { PREVIEW_ORIGIN_SUFFIX, TIMEZONE, VOICE_CALL_CODEX_BIN } from '../../../config.js';
import { deriveHumanRequest, type HumanRequest } from '../../../caller-identity.js';
import { withCentralSync } from '../../../db/central-lease.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { getSession } from '../../../db/sessions.js';
import { readEnvFile } from '../../../env.js';
import { onHostShutdown, onHostStart } from '../../../host-lifecycle.js';
import { log } from '../../../log.js';
import { requestWake } from '../../../request-wake.js';
import { writeSessionMessage } from '../../../session-manager.js';
import { formatLocalTime } from '../../../timezone.js';
import { isChannelVariant } from '../../../types.js';
import { getUser } from '../../permissions/db/users.js';
import { ensureUserDm } from '../../permissions/user-dm.js';
import { VoiceCallBridge, type AdmittedRequest, type CallPorts } from '../call.js';
import { openLiveCall, readCodexLogin } from '../live.js';
import { groupRequestText } from '../prompts.js';
import { groupCallSessions, type CallPageEvent, type CallRoute } from '../registry.js';
import {
  deliverText,
  mayCall,
  RING_MS,
  spokenName,
  voiceCallsEnabledFor,
  VoiceCallRefused,
  voiceFor,
} from '../service.js';
import { followSessionFeed } from '../session-feed.js';
import {
  FRAME_SECONDS,
  nameMatcher,
  requestFromTurn,
  speakerOf,
  type ActivityFrames,
  type HandedOver,
} from './attribution.js';
import { BridgeBrowser } from './bridge-container.js';
import {
  deleteRoom,
  ensureLiveKit,
  groupCallsConfigured,
  LIVEKIT_INTERNAL_URL,
  liveKitSignalPort,
  mintToken,
  removeLeftoverVoiceContainers,
  removeParticipant,
  stopLiveKit,
  verifyToken,
} from './livekit.js';
import { SignalGate, type SignalClaims } from './signal-gate.js';

const GROUP_CALL_MAX_MS = 60 * 60_000;
const MAX_GROUP_CALLS = 2;
const MAX_PEOPLE = 6;
const TOKEN_TTL_SECONDS = 300;
const POLL_MS = 1000;
const RECHECK_MS = 60_000;
const EMPTY_ROOM_MS = 3 * 60_000;
const NOBODY_CAME_MS = 10 * 60_000;
const KEEP_ACTIVITY_SECONDS = 120;
const REMOVE_ATTEMPTS = 3;
const MEMBERSHIP_ATTEMPTS = 3;
const MEMBERSHIP_RETRY_MS = 2000;
const MAX_MEMBER_PAGES = 200;
/** How long a link opened before the room is up waits for it, rather than failing. */
const ROOM_START_WAIT_MS = 60_000;
const MAX_POLL_FAILURES = 5;
const LINK_ID_RE = /^[0-9a-f]{32}$/;

export type GroupPageEvent = CallPageEvent | { type: 'request'; speaker: string; text: string };

interface Participant {
  userId: string;
  name: string;
  /** The LiveKit identity: visible to everyone in the room, so never the link. */
  identity: string;
  linkId: string;
  linkExpiresAt: number;
  claimed: boolean;
  removed: boolean;
  pageToken: string | null;
  /** This person's open event streams: what the call says reaches only people still on it. */
  listeners: Set<(event: GroupPageEvent) => void>;
}

interface GroupCall {
  id: string;
  sessionId: string;
  agentGroupId: string;
  agentName: string;
  route: CallRoute;
  channelId: string;
  state: 'starting' | 'live' | 'ended';
  startedAt: number;
  people: Map<string, Participant>;
  browser: BridgeBrowser | null;
  voice: VoiceCallBridge | null;
  voiceStarting: boolean;
  everJoined: boolean;
  /** Identities in the room at the last poll. */
  present: Set<string>;
  emptySince: number | null;
  frames: ActivityFrames;
  slots: Record<string, number>;
  pieces: Array<{ at: number; startMs: number; endMs: number; text: string }>;
  /** The last turn the voice handed over, which the next delegation of the same turn repeats. */
  previous: HandedOver | null;
  requests: number;
  polling: boolean;
  pollFailures: number;
  /** Stops for everything the call started; ending the call runs them. */
  owned: Array<() => unknown>;
  /** A removal from the room has failed at least once, so ending this call must not leave the room behind. */
  removalFailed: boolean;
  /** Removals still being attempted; a call that ends meanwhile treats them as failed. */
  removing: number;
  /** Resolves once the call is live or has ended. */
  settled: Promise<void>;
  settle: () => void;
}

const groupCalls = new Map<string, GroupCall>();
const links = new Map<string, { callId: string; userId: string }>();

export const groupCallUrl = (linkId: string) => `https://${linkId}.${PREVIEW_ORIGIN_SUFFIX}`;

export const gate = new SignalGate({
  verify: (token) => verifyToken(token),
  admit: (linkId, claims) => admitSignal(linkId, claims),
  upstreamPort: liveKitSignalPort,
});

onHostStart(() => void removeLeftoverVoiceContainers());
onHostShutdown(async () => {
  for (const call of [...groupCalls.values()]) await endGroupCall(call, 'The host restarted, so the call ended.');
});

function liveCallFor(sessionId: string): GroupCall | null {
  for (const call of groupCalls.values()) if (call.sessionId === sessionId && call.state !== 'ended') return call;
  return null;
}

export function groupCallLive(sessionId: string): boolean {
  return liveCallFor(sessionId) !== null;
}

export function linkFor(linkId: string): { call: GroupCall; person: Participant } | null {
  if (!LINK_ID_RE.test(linkId)) return null;
  const found = links.get(linkId);
  const call = found ? groupCalls.get(found.callId) : undefined;
  const person = call?.people.get(found!.userId);
  if (!call || !person || call.state === 'ended' || person.linkId !== linkId) return null;
  return { call, person };
}

function emit(call: GroupCall, event: GroupPageEvent): void {
  for (const person of call.people.values()) {
    if (person.removed) continue;
    for (const listener of person.listeners) listener(event);
  }
}

export function listen(person: Participant, listener: (event: GroupPageEvent) => void): () => void {
  if (person.removed) {
    listener({ type: 'ended', text: 'You are no longer on this call.' });
    return () => undefined;
  }
  person.listeners.add(listener);
  return () => person.listeners.delete(listener);
}

function closeStreams(person: Participant, text: string): void {
  for (const listener of person.listeners) listener({ type: 'ended', text });
  person.listeners.clear();
}

/**
 * Which of these Slack users are in the conversation the call came from: the call hears that thread, so only they may
 * join. Pages the whole member list until every one is found, however large the channel.
 */
async function inChannel(call: Pick<GroupCall, 'route' | 'channelId'>, userIds: string[]): Promise<Set<string>> {
  const key = botTokenKeyForChannelType(call.route.channelType);
  const token = readEnvFile([key])[key];
  if (!token) throw new VoiceCallRefused('Group calls cannot check who is in this channel.');
  const wanted = new Set(userIds.map(rawSlackId));
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_MEMBER_PAGES) throw new VoiceCallRefused('Group calls could not check who is in this channel.');
    const page = await slackRead(
      token,
      'conversations.members',
      { channel: call.channelId, limit: 1000, ...(cursor ? { cursor } : {}) },
      'group-call',
    );
    for (const member of (page.members as unknown[] | undefined) ?? [])
      if (typeof member === 'string' && wanted.has(member)) found.add(member);
    cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor && found.size < wanted.size);
  return found;
}

const rawSlackId = (userId: string) => userId.slice(userId.indexOf(':') + 1);

async function mayJoin(call: Pick<GroupCall, 'route' | 'channelId' | 'agentGroupId'>, userId: string) {
  if (!(await withCentralSync(() => mayCall(userId, call.agentGroupId), 'group-call caller check'))) return false;
  return (await inChannel(call, [userId])).has(rawSlackId(userId));
}

async function admitSignal(linkId: string, claims: SignalClaims): Promise<boolean> {
  const found = linkFor(linkId);
  if (!found) return false;
  const { call, person } = found;
  if (!person.claimed || person.removed || claims.sub !== person.identity || claims.video.room !== call.id)
    return false;
  const allowed = await mayJoin(call, person.userId);
  // The check awaits, so a removal or the call's end can land during it.
  return allowed && !person.removed && !hasEnded(call);
}

async function sendLink(call: GroupCall, userId: string): Promise<{ sentTo: string; expiresAt: string }> {
  const user = await stillOn(call, getUser(userId));
  const previous = call.people.get(userId);
  if (previous) {
    links.delete(previous.linkId);
    if (previous.claimed && !previous.removed) await stillOn(call, removePerson(call, previous, 'joined again'));
  }
  if (!previous && [...call.people.values()].filter((p) => !p.removed).length >= MAX_PEOPLE)
    throw new VoiceCallRefused(`This group call is full (${MAX_PEOPLE} people).`);
  const dm = await stillOn(call, ensureUserDm(userId, { instance: call.route.instance, privacySafeLogs: true }));
  if (!dm) throw new VoiceCallRefused('Could not open a DM to send the call link.');
  const person: Participant = {
    userId,
    name: user?.display_name || 'Someone',
    identity: `p-${randomBytes(6).toString('hex')}`,
    linkId: randomBytes(16).toString('hex'),
    linkExpiresAt: Date.now() + RING_MS,
    claimed: false,
    removed: false,
    pageToken: null,
    listeners: new Set(),
  };
  call.people.set(userId, person);
  links.set(person.linkId, { callId: call.id, userId });
  await stillOn(
    call,
    deliverText(
      {
        channelType: dm.channel_type,
        instance: dm.instance ?? dm.channel_type,
        platformId: dm.platform_id,
        threadId: null,
      },
      `📞 Tap to join the group call with ${call.agentName}: ${groupCallUrl(person.linkId)}\nIt works once and expires at ${formatLocalTime(new Date(person.linkExpiresAt).toISOString(), TIMEZONE)}. Anyone with this link joins as you, so don't forward it.`,
    ),
  );
  return { sentTo: person.name, expiresAt: new Date(person.linkExpiresAt).toISOString() };
}

/**
 * `ncl voice call --group` starts a group call in this conversation, or adds the person who asked to the one already
 * live here. The host picks that person from the thread's latest human message, never from the agent.
 */
export async function startOrJoinGroupCall(input: { sessionId: string; agentGroupId: string }): Promise<{
  joined: boolean;
  sentTo: string;
  expiresAt: string;
}> {
  if (!voiceCallsEnabledFor(input.agentGroupId) || !groupCallsConfigured())
    throw new VoiceCallRefused('Group calls are not enabled for this agent.');
  const session = await getSession(input.sessionId);
  if (!session || session.agent_group_id !== input.agentGroupId || !session.messaging_group_id)
    throw new VoiceCallRefused('Group calls start from a conversation thread.');
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || !(mg.channel_type === 'slack' || isChannelVariant(mg.channel_type, 'slack')))
    throw new VoiceCallRefused('Group calls start from Slack only for now.');
  const channelId = extractSlackChannelId(mg.platform_id);
  if (channelId.startsWith('D'))
    throw new VoiceCallRefused('Group calls start from a channel; in a DM, ask for a call.');
  const request: HumanRequest | null = await deriveHumanRequest(session);
  if (!request) throw new VoiceCallRefused('No person has asked in this thread, so there is no one to call.');
  const route: CallRoute = { ...request.route, instance: mg.instance ?? mg.channel_type, messagingGroupId: mg.id };

  const existing = liveCallFor(session.id);
  if (existing) {
    const already = existing.people.get(request.userId);
    // The asker is the latest person who typed in the thread, so a request spoken on the call would otherwise pull
    // someone already on it out to re-send their link.
    if (already && already.claimed && !already.removed && existing.present.has(already.identity))
      throw new VoiceCallRefused(
        `${already.name} is already on this call. Anyone else who wants to join asks in Slack to be added.`,
      );
    try {
      if (!(await stillOn(existing, mayJoin(existing, request.userId))))
        throw new VoiceCallRefused('Only people in this channel who can talk to this agent can join its group call.');
      return { joined: true, ...(await sendLink(existing, request.userId)) };
    } catch (err) {
      if (err instanceof CallEnded) throw new VoiceCallRefused('That group call just ended; ask for a new one.');
      throw err;
    }
  }
  if ([...groupCalls.values()].filter((c) => c.state !== 'ended').length >= MAX_GROUP_CALLS)
    throw new VoiceCallRefused('Too many group calls are live on this host right now.');
  const pending = { route, channelId, agentGroupId: input.agentGroupId };
  if (!(await mayJoin(pending, request.userId)))
    throw new VoiceCallRefused('Only people in this channel who can talk to this agent can start a group call.');

  const agentGroup = await getAgentGroup(input.agentGroupId);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const call: GroupCall = {
    id: randomBytes(16).toString('hex'),
    sessionId: session.id,
    agentGroupId: input.agentGroupId,
    agentName: agentGroup ? await spokenName(agentGroup, mg.id) : 'your agent',
    route,
    channelId,
    state: 'starting',
    startedAt: Date.now(),
    people: new Map(),
    browser: null,
    voice: null,
    voiceStarting: false,
    everJoined: false,
    present: new Set(),
    emptySince: null,
    frames: new Map(),
    slots: {},
    pieces: [],
    previous: null,
    requests: 0,
    polling: false,
    pollFailures: 0,
    owned: [],
    removalFailed: false,
    removing: 0,
    settled,
    settle,
  };
  groupCalls.set(call.id, call);
  groupCallSessions.set(call.sessionId, call.startedAt + GROUP_CALL_MAX_MS);
  let sent: { sentTo: string; expiresAt: string };
  try {
    sent = await sendLink(call, request.userId);
  } catch (err) {
    if (err instanceof CallEnded) throw new VoiceCallRefused('The group call ended before it started.');
    await endGroupCall(call, 'The call link could not be sent.');
    throw err;
  }
  void deliverText(
    route,
    `📞 ${sent.sentTo} started a group call with ${call.agentName}. To join, ask ${call.agentName} to add you to the call; the link comes to your DM.`,
  ).catch((err: unknown) => log.warn('Group call: thread post failed', { callId: call.id.slice(0, 8), err }));
  void setUpRoom(call);
  log.info('Group call started', { callId: call.id.slice(0, 8), sessionId: session.id });
  return { joined: false, ...sent };
}

/** Read through a call so a check after an await is not narrowed away by one before it. */
const hasEnded = (call: GroupCall) => call.state === 'ended';

class CallEnded extends Error {
  constructor() {
    super('The group call ended.');
  }
}

/**
 * A call's lifetime: everything it starts registers its stop with `own`, and everything it waits on goes through
 * `stillOn`, so nothing outlives the call and nothing resumes for it once it has ended. Both throw `CallEnded` for an
 * ended call, after stopping what was just started.
 */
function own(call: GroupCall, stop: () => unknown): void {
  if (!hasEnded(call)) {
    call.owned.push(stop);
    return;
  }
  void Promise.resolve()
    .then(stop)
    .catch((err: unknown) => log.warn('Group call: could not stop what it started', { err }));
  throw new CallEnded();
}

async function stillOn<T>(call: GroupCall, work: Promise<T>): Promise<T> {
  const value = await work;
  if (hasEnded(call)) throw new CallEnded();
  return value;
}

async function setUpRoom(call: GroupCall): Promise<void> {
  if (hasEnded(call)) return;
  try {
    await stillOn(call, ensureLiveKit());
    const browser = await BridgeBrowser.start(call.id, Math.ceil(GROUP_CALL_MAX_MS / 1000) + 120);
    own(call, () => browser.stop());
    call.browser = browser;
    await stillOn(
      call,
      browser.join(
        LIVEKIT_INTERNAL_URL,
        mintToken(
          {
            sub: 'agent',
            name: call.agentName,
            video: {
              room: call.id,
              roomJoin: true,
              canPublish: true,
              canSubscribe: true,
              canPublishData: false,
              canUpdateOwnMetadata: false,
            },
          },
          3600,
        ),
      ),
    );
    call.state = 'live';
    call.settle();
    const every = (ms: number, fn: () => Promise<void>) => {
      const timer = setInterval(
        () =>
          void fn().catch((err: unknown) => {
            if (!(err instanceof CallEnded))
              log.warn('Group call: periodic check failed', { callId: call.id.slice(0, 8), err });
          }),
        ms,
      );
      timer.unref();
      own(call, () => clearInterval(timer));
    };
    every(POLL_MS, () => poll(call));
    every(RECHECK_MS, () => recheck(call));
    const cap = setTimeout(() => void endGroupCall(call, 'The call reached its one-hour limit.'), GROUP_CALL_MAX_MS);
    cap.unref();
    own(call, () => clearTimeout(cap));
  } catch (err) {
    if (hasEnded(call)) return;
    log.warn('Group call: the room could not start', { callId: call.id.slice(0, 8), err });
    await endGroupCall(call, 'The call room could not start.');
  }
}

async function poll(call: GroupCall): Promise<void> {
  if (call.state !== 'live' || !call.browser || call.polling) return;
  call.polling = true;
  try {
    await pollOnce(call, call.browser);
    call.pollFailures = 0;
  } catch (err) {
    if (hasEnded(call)) return;
    call.pollFailures += 1;
    if (call.pollFailures >= MAX_POLL_FAILURES) await endGroupCall(call, 'The call bridge stopped answering.');
    else throw err;
  } finally {
    call.polling = false;
  }
}

async function pollOnce(call: GroupCall, browser: BridgeBrowser): Promise<void> {
  const snapshot = await stillOn(call, browser.collect());
  for (const [frame, ...levels] of snapshot.frames) call.frames.set(frame, levels);
  call.slots = snapshot.slots;
  call.pieces.push(...snapshot.pieces);
  const latest = snapshot.frames.length ? snapshot.frames[snapshot.frames.length - 1][0] : null;
  if (latest !== null) {
    const oldest = latest - KEEP_ACTIVITY_SECONDS / FRAME_SECONDS;
    for (const frame of call.frames.keys()) if (frame < oldest) call.frames.delete(frame);
    const since = latest * FRAME_SECONDS - KEEP_ACTIVITY_SECONDS;
    call.pieces = call.pieces.filter((piece) => piece.at >= since);
  }
  call.present = new Set(snapshot.people);
  const now = Date.now();
  if (snapshot.people.length > 0) {
    call.everJoined = true;
    call.emptySince = null;
    if (!call.voice && !call.voiceStarting) void startVoice(call);
  } else {
    call.emptySince ??= now;
    if (call.everJoined && now - call.emptySince > EMPTY_ROOM_MS) await endGroupCall(call, 'Everyone left the call.');
    else if (!call.everJoined && now - call.startedAt > NOBODY_CAME_MS)
      await endGroupCall(call, 'Nobody joined the call.');
  }
  if (call.voice && snapshot.live === 'connected') call.voice.audioConnected();
  if (snapshot.live === 'failed' || snapshot.live === 'closed')
    await endGroupCall(call, 'The voice connection dropped.');
}

async function recheck(call: GroupCall): Promise<void> {
  if (call.state === 'ended') return;
  const onCall = [...call.people.values()].filter((p) => p.claimed && !p.removed).map((p) => p.userId);
  let members: Set<string> | null = null;
  for (let attempt = 1; attempt <= MEMBERSHIP_ATTEMPTS && !members; attempt++) {
    try {
      members = await stillOn(call, inChannel(call, onCall));
    } catch (err) {
      if (hasEnded(call)) return;
      log.warn('Group call: membership check failed', { callId: call.id.slice(0, 8), attempt, err });
      if (attempt < MEMBERSHIP_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_RETRY_MS));
    }
  }
  if (!members) {
    await endGroupCall(call, 'The call ended because who may join it could not be checked.');
    return;
  }
  const checked = new Set(onCall);
  for (const person of call.people.values()) {
    if (person.removed) continue;
    if (!person.claimed) {
      if (Date.now() > person.linkExpiresAt) {
        person.removed = true;
        links.delete(person.linkId);
      }
      continue;
    }
    // Claimed while this check was asking Slack; their own claim checked them.
    if (!checked.has(person.userId)) continue;
    const allowed =
      members.has(rawSlackId(person.userId)) &&
      (await stillOn(
        call,
        withCentralSync(() => mayCall(person.userId, call.agentGroupId), 'group-call caller check'),
      ));
    if (!allowed) await removePerson(call, person, 'lost access');
  }
}

/**
 * Revokes first, so no later connection is admitted; removing from the room stops media already flowing and tells
 * the person why; closing their signaling comes last so that message gets through.
 */
async function removePerson(call: GroupCall, person: Participant, why: string): Promise<void> {
  person.removed = true;
  links.delete(person.linkId);
  closeStreams(person, 'You were removed from the call.');
  gate.revoke(call.id, person.identity);
  if (call.state !== 'live') return;
  call.removing += 1;
  try {
    for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
      try {
        await removeParticipant(call.id, person.identity);
        gate.disconnect(call.id, person.identity);
        log.info('Group call: participant removed', { callId: call.id.slice(0, 8), why });
        return;
      } catch (err) {
        call.removalFailed = true;
        log.warn('Group call: remove failed', { callId: call.id.slice(0, 8), attempt, err });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (hasEnded(call)) return;
      }
    }
  } finally {
    call.removing -= 1;
  }
  gate.disconnect(call.id, person.identity);
  // LiveKit keeps a participant's media flowing after its signaling closes; ending the room is the only fallback.
  await endGroupCall(call, 'Someone had to be removed from the call and could not be, so the call ended.');
}

export async function claimLink(linkId: string): Promise<{ token: string; url: string; pageToken: string } | null> {
  const found = linkFor(linkId);
  if (!found) return null;
  const { call, person } = found;
  if (person.claimed || person.removed || Date.now() > person.linkExpiresAt || call.state === 'ended') return null;
  person.claimed = true;
  if (call.state === 'starting') {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([call.settled, new Promise((resolve) => (timer = setTimeout(resolve, ROOM_START_WAIT_MS)))]);
    clearTimeout(timer);
  }
  const allowed =
    !hasEnded(call) &&
    call.state === 'live' &&
    !person.removed &&
    (await stillOn(call, mayJoin(call, person.userId)).catch((err: unknown) => {
      if (err instanceof CallEnded) return false;
      throw err;
    }));
  if (!allowed) {
    person.removed = true;
    links.delete(linkId);
    return null;
  }
  person.pageToken = randomBytes(16).toString('hex');
  const token = mintToken(
    {
      sub: person.identity,
      name: person.name,
      video: {
        room: call.id,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: ['microphone'],
        canUpdateOwnMetadata: false,
      },
    },
    TOKEN_TTL_SECONDS,
  );
  return { token, url: `wss://${linkId}.${PREVIEW_ORIGIN_SUFFIX}`, pageToken: person.pageToken };
}

export async function leave(linkId: string): Promise<void> {
  const found = linkFor(linkId);
  if (found && !found.person.removed) await removePerson(found.call, found.person, 'left');
}

async function startVoice(call: GroupCall): Promise<void> {
  if (!call.browser || call.voice || call.voiceStarting || hasEnded(call)) return;
  call.voiceStarting = true;
  try {
    const voice = new VoiceCallBridge(
      { agentName: call.agentName, callerName: 'the group', group: true },
      portsFor(call),
    );
    call.voice = voice;
    const offer = await stillOn(call, call.browser.liveOffer());
    const answer = await stillOn(call, voice.start(offer));
    await stillOn(call, call.browser.liveAnswer(answer));
  } catch (err) {
    if (hasEnded(call)) return;
    log.warn('Group call: the voice could not start', { callId: call.id.slice(0, 8), err });
    await endGroupCall(call, 'The voice could not join the call.');
  } finally {
    call.voiceStarting = false;
  }
}

async function admit(
  call: GroupCall,
  turn: string,
  now: number,
): Promise<AdmittedRequest | 'not-addressed' | 'duplicate'> {
  const isName = nameMatcher(call.agentName);
  const request = requestFromTurn(turn, isName, call.previous, now);
  if (!request) return 'not-addressed';
  if (request === 'duplicate') return 'duplicate';
  call.previous = { turn, atMs: now };
  await poll(call).catch(() => undefined);
  const identity = speakerOf({ pieces: call.pieces, frames: call.frames, slots: call.slots, isName });
  const speaker = identity ? ([...call.people.values()].find((p) => p.identity === identity)?.name ?? null) : null;
  const first = call.requests === 0;
  emit(call, { type: 'request', speaker: speaker ?? 'Someone', text: request.shown });
  return {
    text: groupRequestText({ speaker, request: request.text, first }),
    sender: `${speaker ?? 'Someone on the call'} (voice)`,
    mirror: `🎙️ *${speaker ?? 'Someone on the call'}* (voice): ${request.shown}`,
  };
}

function portsFor(call: GroupCall): CallPorts {
  const prefix = `voice-${call.id}-`;
  return {
    openLive: ({ offer, instructions, onEvent }) =>
      openLiveCall({
        offer,
        instructions,
        onEvent,
        login: () => readCodexLogin(VOICE_CALL_CODEX_BIN),
        voice: voiceFor(call.agentGroupId),
      }),
    feed: (onEvent) =>
      followSessionFeed({ agentGroupId: call.agentGroupId, sessionId: call.sessionId }, call.route, prefix, onEvent),
    admit: (_delegationId, turn, arrivedAtMs) => admit(call, turn, arrivedAtMs),
    // No sender id: who spoke is a guess, so the host's privileged actions see an unidentified sender and ask for
    // an approval instead of acting for anyone.
    inject: (text, wake, sender) => {
      call.requests += 1;
      const id = `${prefix}${call.requests}`;
      const written = writeSessionMessage(
        call.agentGroupId,
        call.sessionId,
        {
          id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: call.route.platformId,
          channelType: call.route.channelType,
          messagingGroupId: call.route.messagingGroupId,
          threadId: call.route.threadId,
          content: JSON.stringify({ text, sender: sender ?? 'Group call' }),
          trigger: wake ? 1 : 0,
        },
        { guard: () => !wake || call.state === 'live' || { ok: false, reason: 'the group call ended' } },
      ).then(async () => {
        if (!wake) return;
        const session = await getSession(call.sessionId);
        if (session) await requestWake(session, 'inbound-message').catch(() => undefined);
      });
      return { id, written };
    },
    mirror: (text) =>
      void deliverText(call.route, text).catch((err: unknown) =>
        log.warn('Group call: thread post failed', { callId: call.id.slice(0, 8), err }),
      ),
    status: (text) => emit(call, { type: 'status', text }),
    caption: (role, text, done) => {
      if (role === 'voice') emit(call, { type: 'caption', role, text, done });
    },
    ended: (text) => void endGroupCall(call, text),
  };
}

async function endGroupCall(call: GroupCall, reason: string): Promise<void> {
  if (call.state === 'ended') return;
  call.state = 'ended';
  call.settle();
  call.voice?.end({ dropped: false, reason });
  void deliverText(call.route, `📞 Group call ended: ${reason}`).catch((err: unknown) =>
    log.warn('Group call: thread post failed', { callId: call.id.slice(0, 8), err }),
  );
  for (const person of call.people.values()) {
    closeStreams(person, reason);
    links.delete(person.linkId);
  }
  gate.forgetRoom(call.id);
  for (const stop of call.owned.splice(0))
    await Promise.resolve()
      .then(stop)
      .catch((err: unknown) => log.warn('Group call: could not stop what it started', { err }));
  const roomGone = await deleteRoom(call.id).then(
    () => true,
    (err: unknown) => {
      log.warn('Group call: the room could not be deleted', { callId: call.id.slice(0, 8), err });
      return false;
    },
  );
  groupCalls.delete(call.id);
  groupCallSessions.delete(call.sessionId);
  // That room may still carry the person who could not be removed; only stopping the server ends that for sure.
  const stopServer = !roomGone && (call.removalFailed || call.removing > 0);
  if (stopServer) {
    log.error('Group call: someone could not be removed and their room survived, so the room server stops', {
      callId: call.id.slice(0, 8),
    });
    for (const other of [...groupCalls.values()]) await endGroupCall(other, 'The call server had to stop.');
  }
  if (groupCalls.size === 0 || stopServer) await stopLiveKit();
  log.info('Group call ended', { callId: call.id.slice(0, 8), reason, requests: call.requests });
}
