// Voice calls are not available in this build: the voice service they use is not published.

export interface CodexLogin {
  token: string;
  accountId: string;
}

export type ContextChannel = 'speakable' | 'commentary';

export type LiveEvent =
  | { type: 'started' }
  | { type: 'delegation'; id: string; text: string }
  | { type: 'transcript'; role: 'caller' | 'voice'; text: string }
  | { type: 'turn-done'; role: 'caller' | 'voice'; transcript: string }
  | { type: 'closed'; reason: string | null };

export interface LiveCall {
  answer: string;
  context(text: string, channel: ContextChannel, delegationId?: string): void;
  close(): void;
}

export class VoiceServiceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'VoiceServiceError';
  }
}

const UNAVAILABLE = 'Voice calls are not available in this build.';

export async function readCodexLogin(_codexBin: string, _opts: { refresh?: boolean } = {}): Promise<CodexLogin> {
  throw new VoiceServiceError(UNAVAILABLE);
}

export async function openLiveCall(_opts: {
  offer: string;
  instructions: string;
  onEvent: (event: LiveEvent) => void;
  login: () => Promise<CodexLogin>;
  voice?: string;
}): Promise<LiveCall> {
  throw new VoiceServiceError(UNAVAILABLE);
}
