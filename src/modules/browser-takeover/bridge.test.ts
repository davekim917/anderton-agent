import { spawn } from 'child_process';
import net from 'net';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { loopbackRelayScript } from './bridge.js';

// The relay runs inside the container under `docker exec`; plain bash on the host runs the same script.
let server: net.Server | null = null;

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

function echoServer(onConnection: (socket: net.Socket) => void): Promise<number> {
  server = net.createServer(onConnection);
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)),
  );
}

function relay(port: number) {
  const child = spawn('bash', ['-c', loopbackRelayScript(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, exited, output: () => out };
}

const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay did not exit')), ms))]);

describe('loopbackRelayScript', () => {
  it('carries bytes both ways and exits when the upstream closes', async () => {
    const port = await echoServer((socket) =>
      socket.on('data', (d) => {
        socket.write(`echo:${d.toString()}`);
        socket.end();
      }),
    );
    const r = relay(port);
    r.child.stdin.write('ping');
    await within(r.exited);
    expect(r.output()).toBe('echo:ping');
  });

  it('exits when its stdin closes, though the upstream keeps the connection open', async () => {
    let upstreamClosed = false;
    const port = await echoServer((socket) => socket.resume().on('close', () => (upstreamClosed = true)));
    const r = relay(port);
    r.child.stdin.write('hello');
    r.child.stdin.end();
    await within(r.exited);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamClosed).toBe(true);
  });

  it('refuses a port that is not a TCP port number', () => {
    expect(() => loopbackRelayScript(0)).toThrow();
    expect(() => loopbackRelayScript(70000)).toThrow();
    expect(() => loopbackRelayScript(1.5)).toThrow();
  });
});
