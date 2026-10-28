import type { IncomingMessage, ServerResponse } from 'http';
import { connect, type Socket } from 'net';

const SOCKET_PATHS = new Set(['/rtc', '/rtc/v1']);
const VALIDATE_PATHS = new Set(['/rtc/validate', '/rtc/v1/validate']);
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
};

export interface SignalClaims {
  sub: string;
  video: { room: string };
}

export interface SignalGateDeps {
  verify(token: string | null): SignalClaims;
  /** Whether the person this link belongs to may be in this room right now, as this token's identity. */
  admit(linkId: string, claims: SignalClaims): Promise<boolean>;
  upstreamPort(): number;
  openUpstream?(port: number): Socket;
}

function signalUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://signal');
  } catch {
    return null;
  }
}

interface Admission {
  state: 'pending' | 'open';
  client: Socket;
  upstream: Socket | null;
}

/**
 * The only way to LiveKit's signaling port. Every WebSocket upgrade, fresh join or resume, is checked against the
 * person's standing at that moment, so a token LiveKit itself refreshed is useless to someone removed from the call;
 * media cannot start without signaling. LiveKit serves its admin API on the same port, so any other path is refused.
 */
export class SignalGate {
  private readonly revoked = new Set<string>();
  private readonly forgotten = new Set<string>();
  private readonly admissions = new Map<string, Set<Admission>>();

  constructor(private readonly deps: SignalGateDeps) {}

  private key(room: string, identity: string) {
    return `${room}|${identity}`;
  }

  isRevoked(room: string, identity: string): boolean {
    return this.revoked.has(this.key(room, identity));
  }

  private async authorize(linkId: string, url: URL): Promise<{ status: 200 | 401 | 403; claims?: SignalClaims }> {
    let claims: SignalClaims;
    try {
      claims = this.deps.verify(url.searchParams.get('access_token'));
    } catch {
      return { status: 401 };
    }
    if (this.forgotten.has(claims.video.room) || this.isRevoked(claims.video.room, claims.sub))
      return { status: 403, claims };
    return (await this.deps.admit(linkId, claims)) ? { status: 200, claims } : { status: 403, claims };
  }

  /** Answers LiveKit's pre-connect check; false when the path is not signaling. */
  handleRequest(linkId: string, req: IncomingMessage, res: ServerResponse): boolean {
    const url = signalUrl(req);
    if (!url) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(STATUS_TEXT[400]);
      return true;
    }
    if (!VALIDATE_PATHS.has(url.pathname)) return false;
    void (async () => {
      const verdict = await this.authorize(linkId, url).catch(() => ({ status: 403 as const }));
      if (verdict.status !== 200 || req.method !== 'GET') {
        res.writeHead(verdict.status === 200 ? 405 : verdict.status, { 'content-type': 'text/plain' });
        res.end(verdict.status === 200 ? 'method not allowed' : STATUS_TEXT[verdict.status]);
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:${this.deps.upstreamPort()}${url.pathname}${url.search}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!upstream) {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(STATUS_TEXT[502]);
        return;
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
      res.end(await upstream.text());
    })();
    return true;
  }

  /** Relays an authorized signaling upgrade; false when the path is not signaling. */
  handleUpgrade(linkId: string, req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = signalUrl(req);
    if (!url) {
      this.refuse(socket, 400);
      return true;
    }
    if (!SOCKET_PATHS.has(url.pathname)) return false;
    socket.on('error', () => socket.destroy());
    void this.relay(linkId, url, req, socket, head);
    return true;
  }

  private refuse(socket: Socket, status: number): void {
    const body = STATUS_TEXT[status] ?? 'Refused';
    socket.end(
      `HTTP/1.1 ${status} ${body}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
  }

  private async relay(linkId: string, url: URL, req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const pending: Admission = { state: 'pending', client: socket, upstream: null };
    const verdict = await this.authorize(linkId, url).catch(() => ({ status: 403 as const, claims: undefined }));
    if (verdict.status !== 200 || !verdict.claims) {
      this.refuse(socket, verdict.status);
      return;
    }
    const key = this.key(verdict.claims.video.room, verdict.claims.sub);
    // The standing check awaits, so a revocation can land during it; the revoked set is the fence.
    if (this.revoked.has(key) || this.forgotten.has(verdict.claims.video.room) || socket.destroyed) {
      this.refuse(socket, 403);
      return;
    }
    const admissions = this.admissions.get(key) ?? new Set<Admission>();
    this.admissions.set(key, admissions);
    admissions.add(pending);
    const upstream = (this.deps.openUpstream ?? ((port) => connect(port, '127.0.0.1')))(this.deps.upstreamPort());
    pending.upstream = upstream;
    const close = () => {
      admissions.delete(pending);
      if (admissions.size === 0 && this.admissions.get(key) === admissions) this.admissions.delete(key);
      upstream.destroy();
      socket.destroy();
    };
    socket.on('close', close);
    upstream.on('error', close);
    upstream.on('close', close);
    upstream.on('connect', () => {
      if (socket.destroyed) return close();
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(
          `${name}: ${name.toLowerCase() === 'host' ? `127.0.0.1:${this.deps.upstreamPort()}` : req.rawHeaders[i + 1]}`,
        );
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      // Nothing else from the client reaches the room server until it has switched protocols: a refused upgrade on a
      // kept-alive connection would otherwise carry a second, unchecked request to its admin API.
      let answer = Buffer.alloc(0);
      const onAnswer = (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk]);
        const lineEnd = answer.indexOf('\r\n');
        if (lineEnd < 0 && answer.length < 64) return;
        upstream.off('data', onAnswer);
        if (!answer.subarray(0, Math.max(lineEnd, 0)).toString('latin1').startsWith('HTTP/1.1 101 ')) {
          upstream.off('close', close);
          upstream.destroy();
          socket.end(answer);
          return;
        }
        socket.write(answer);
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
        pending.state = 'open';
      };
      upstream.on('data', onAnswer);
    });
  }

  /**
   * Marks the identity revoked, so every later upgrade, fresh join or resume, is refused, and drops any upgrade still
   * being admitted. Open signaling stays up so the room server can tell the person why it removes them.
   */
  revoke(room: string, identity: string): void {
    const key = this.key(room, identity);
    this.revoked.add(key);
    for (const admission of this.admissions.get(key) ?? []) {
      if (admission.state !== 'pending') continue;
      admission.client.destroy();
      admission.upstream?.destroy();
    }
  }

  disconnect(room: string, identity: string): number {
    const key = this.key(room, identity);
    const admissions = this.admissions.get(key);
    this.admissions.delete(key);
    for (const admission of admissions ?? []) {
      admission.client.destroy();
      admission.upstream?.destroy();
    }
    return admissions?.size ?? 0;
  }

  forgetRoom(room: string): void {
    this.forgotten.add(room);
    for (const key of [...this.revoked]) if (key.startsWith(`${room}|`)) this.revoked.delete(key);
    for (const [key, admissions] of [...this.admissions]) {
      if (!key.startsWith(`${room}|`)) continue;
      for (const admission of admissions) {
        admission.client.destroy();
        admission.upstream?.destroy();
      }
      this.admissions.delete(key);
    }
  }
}
