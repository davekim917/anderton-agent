import type { VoiceCallBridge } from './call.js';

const HOLD_AHEAD_MS = 2 * 60_000;
/** 128 random bits as lowercase hex: a valid DNS label, as preview ids are, and the link's only credential. */
const CALL_ID_RE = /^[0-9a-f]{32}$/;

type CallState = 'ringing' | 'connecting' | 'live' | 'ended';

export interface CallRoute {
  channelType: string;
  instance: string;
  platformId: string;
  threadId: string | null;
  messagingGroupId: string;
}

export type CallPageEvent =
  | { type: 'status'; text: string }
  | { type: 'caption'; role: 'caller' | 'voice'; text: string; done: boolean }
  | { type: 'ended'; text: string };

export interface VoiceCall {
  id: string;
  sessionId: string;
  agentGroupId: string;
  agentName: string;
  callerId: string;
  callerName: string;
  callerHandle: string;
  route: CallRoute;
  state: CallState;
  token: string | null;
  expiresAt: number;
  timer: NodeJS.Timeout;
  audioTimer: NodeJS.Timeout | null;
  recheckTimer: NodeJS.Timeout | null;
  bridge: VoiceCallBridge | null;
  listeners: Set<(event: CallPageEvent) => void>;
  requests: number;
}

export const calls = new Map<string, VoiceCall>();

/** Sessions with a live group call, to the instant that call's hour runs out. */
export const groupCallSessions = new Map<string, number>();

export function getVoiceCall(id: string): VoiceCall | null {
  if (!CALL_ID_RE.test(id)) return null;
  const call = calls.get(id);
  return call && call.state !== 'ended' ? call : null;
}

export function voiceCallHeldUntilMs(sessionId: string, now = Date.now()): number | null {
  const groupEndsAt = groupCallSessions.get(sessionId);
  let until: number | null = groupEndsAt === undefined ? null : Math.min(groupEndsAt, now + HOLD_AHEAD_MS);
  for (const call of calls.values()) {
    if (call.sessionId !== sessionId || call.state === 'ended') continue;
    const at = call.state === 'ringing' ? call.expiresAt : Math.min(call.expiresAt, now + HOLD_AHEAD_MS);
    until = until === null ? at : Math.max(until, at);
  }
  return until;
}
