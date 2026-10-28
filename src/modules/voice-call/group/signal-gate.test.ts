import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { SignalGate, type SignalClaims } from './signal-gate.js';

const ROOM = 'room-1';

/** A loopback upstream standing in for LiveKit: records each request line and echoes after the headers. */
async function upstream() {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString();
      if (buffered.includes('\r\n\r\n') && !seen.includes(buffered)) {
        seen.push(buffered.split('\r\n\r\n')[0]);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

const servers: Array<() => void> = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

async function stage(admit: (linkId: string, claims: SignalClaims) => Promise<boolean>, upstreamPort?: number) {
  const up = await upstream();
  const gate = new SignalGate({
    verify: (token) => {
      if (!token?.startsWith('good:')) throw new Error('bad token');
      return { sub: token.slice('good:'.length), video: { room: ROOM } };
    },
    admit,
    upstreamPort: () => upstreamPort ?? up.port,
  });
  const server = http.createServer((req, res) => {
    if (!gate.handleRequest('link-1', req, res)) res.writeHead(404).end('not signaling');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!gate.handleUpgrade('link-1', req, socket as net.Socket, head)) socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(() => server.close(), up.close);
  return { gate, up, port: (server.address() as AddressInfo).port };
}

/** Sends a WebSocket upgrade and resolves with the first response line and the socket. */
function upgrade(port: number, path: string): Promise<{ status: string; socket: net.Socket; body: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('\r\n')) resolve({ status: received.split('\r\n')[0], socket, body: () => received });
    });
    socket.on('error', reject);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: link-1.calls.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  });
}

const closed = (socket: net.Socket) =>
  new Promise<boolean>((resolve) => {
    if (socket.destroyed || socket.readableEnded) return resolve(true);
    socket.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });

describe('SignalGate', () => {
  it('relays an admitted upgrade to the room server with the host rewritten', async () => {
    const { up, port } = await stage(async () => true);
    const { status, body } = await upgrade(port, '/rtc/v1?access_token=good:p-1&join_request=x');
    expect(status).toBe('HTTP/1.1 101 Switching Protocols');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(body()).toContain('hello');
    expect(up.seen[0]).toContain('GET /rtc/v1?access_token=good:p-1&join_request=x HTTP/1.1');
    expect(up.seen[0]).toContain(`Host: 127.0.0.1:${up.port}`);
  });

  it.each([
    ['the admin API', '/twirp/livekit.RoomService/ListRooms?access_token=good:p-1'],
    ['a path outside signaling', '/rtc/v2?access_token=good:p-1'],
  ])('never forwards %s', async (_what, path) => {
    const { up, port } = await stage(async () => true);
    const { status } = await upgrade(port, path);
    expect(status).toBe('HTTP/1.1 404 Not Found');
    expect(up.seen).toEqual([]);
  });

  it('forwards nothing past a refused upgrade on a connection the room server keeps open', async () => {
    const requests: string[] = [];
    const sockets = new Set<net.Socket>();
    const keepAlive = net.createServer((socket) => {
      sockets.add(socket);
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString();
        for (const line of buffered.split('\r\n').filter((l) => /^(GET|POST) /.test(l))) requests.push(line);
        buffered = '';
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => keepAlive.listen(0, '127.0.0.1', resolve));
    servers.push(() => {
      for (const socket of sockets) socket.destroy();
      keepAlive.close();
    });
    const { port } = await stage(async () => true, (keepAlive.address() as AddressInfo).port);

    const client = net.connect(port, '127.0.0.1');
    let received = '';
    client.on('data', (chunk) => (received += chunk.toString()));
    client.on('error', () => undefined);
    client.write(
      'GET /rtc/v1?access_token=good:p-1 HTTP/1.1\r\nHost: link-1.calls.example\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n' +
        'POST /twirp/livekit.RoomService/ListRooms HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n',
    );
    expect(await closed(client)).toBe(true);
    expect(received.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
    expect(requests).toEqual(['GET /rtc/v1?access_token=good:p-1 HTTP/1.1']);
  });

  it('refuses an upgrade whose standing check was in flight when its room was forgotten', async () => {
    let admit!: (ok: boolean) => void;
    const { gate, up, port } = await stage(() => new Promise<boolean>((resolve) => (admit = resolve)));
    const pending = upgrade(port, '/rtc/v1?access_token=good:p-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.forgetRoom(ROOM);
    admit(true);
    expect((await pending).status).toBe('HTTP/1.1 403 Forbidden');
    expect(up.seen).toEqual([]);
  });

  it('answers a malformed request target with 400, whether a plain request or an upgrade', async () => {
    const { up, port } = await stage(async () => true);
    const plain = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.includes('\r\n')) resolve(received.split('\r\n')[0]);
      });
      socket.on('error', reject);
      socket.write('GET //[ HTTP/1.1\r\nHost: link-1.calls.example\r\n\r\n');
    });
    expect(plain).toBe('HTTP/1.1 400 Bad Request');
    expect((await upgrade(port, '//[')).status).toBe('HTTP/1.1 400 Bad Request');
    expect(up.seen).toEqual([]);
  });

  it.each([
    ['a token it cannot verify', 'bad', async () => true, '401'],
    ['a person whose standing is refused', 'good:p-1', async () => false, '403'],
  ])('refuses %s', async (_what, token, admit, code) => {
    const { up, port } = await stage(admit);
    const { status } = await upgrade(port, `/rtc?access_token=${token}`);
    expect(status).toContain(code);
    expect(up.seen).toEqual([]);
  });

  it('refuses an upgrade whose standing check was in flight when the person was revoked', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    const { gate, up, port } = await stage(() => new Promise<boolean>((resolve) => (release = resolve)));
    const pending = upgrade(port, '/rtc/v1?access_token=good:p-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.revoke(ROOM, 'p-1');
    release(true);
    expect((await pending).status).toBe('HTTP/1.1 403 Forbidden');
    expect(up.seen).toEqual([]);
  });

  it('closes a revoked person’s open signaling and refuses their resume', async () => {
    const { gate, up, port } = await stage(async () => true);
    const open = await upgrade(port, '/rtc/v1?access_token=good:p-1');
    expect(open.status).toBe('HTTP/1.1 101 Switching Protocols');
    gate.revoke(ROOM, 'p-1');
    expect(gate.disconnect(ROOM, 'p-1')).toBe(1);
    expect(await closed(open.socket)).toBe(true);
    const resume = await upgrade(port, '/rtc/v1?access_token=good:p-1&join_request=resume');
    expect(resume.status).toBe('HTTP/1.1 403 Forbidden');
    expect(up.seen).toHaveLength(1);
  });

  it('answers the pre-connect check only for an admitted person', async () => {
    const validate = http.createServer((_req, res) => res.end('success'));
    await new Promise<void>((resolve) => validate.listen(0, '127.0.0.1', resolve));
    servers.push(() => validate.close());
    let allowed = true;
    const gate = new SignalGate({
      verify: () => ({ sub: 'p-1', video: { room: ROOM } }),
      admit: async () => allowed,
      upstreamPort: () => (validate.address() as AddressInfo).port,
    });
    const server = http.createServer((req, res) => {
      if (!gate.handleRequest('link-1', req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rtc/v1/validate?access_token=t`;
    expect(await (await fetch(url)).text()).toBe('success');
    allowed = false;
    expect((await fetch(url)).status).toBe(403);
  });
});
