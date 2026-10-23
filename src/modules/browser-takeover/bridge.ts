import { spawn } from 'child_process';
import { Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

export const DASHBOARD_CONTAINER_PORT = 4848;

/**
 * Relays stdin/stdout to a loopback port. Whichever side ends first ends both: `docker exec` does not stop the
 * in-container process when its client goes away, so a relay waiting on the other direction would outlive it.
 * Stdin is duplicated to fd 4 first because a non-interactive shell gives a background job /dev/null as stdin.
 */
export function loopbackRelayScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid container port: ${port}`);
  return `exec 3<>/dev/tcp/127.0.0.1/${port} 4<&0; cat <&3 & cat <&4 >&3 & wait -n; kill $(jobs -p) 2>/dev/null`;
}

/**
 * A byte stream to a port on the container's own loopback, carried over `docker exec`. Publishing the port instead
 * would expose it to every other container on the bridge network.
 */
export function openContainerLoopback(containerName: string, port: number): Duplex {
  const child = spawn(CONTAINER_RUNTIME_BIN, ['exec', '-i', containerName, 'bash', '-c', loopbackRelayScript(port)], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {});
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  // Duplex.from reports a bare destroy() as an AbortError, where a net.Socket reports nothing. http.Agent relies on
  // that: it destroys a socket its full free pool cannot take after the request has stopped listening for errors.
  const destroyPipes = stream._destroy.bind(stream);
  stream._destroy = (err, callback) => destroyPipes(err, (pipeErr) => callback(err ? (pipeErr ?? err) : null));
  // An error with no other listener has no request to fail, so it is logged instead of taking the host down.
  stream.on('error', (err) => {
    if (stream.listenerCount('error') === 1) log.warn('Container loopback failed', { containerName, port, err });
  });
  stream.on('close', () => child.kill());
  child.on('error', (err) => stream.destroy(err));
  child.on('exit', () => stream.destroy());
  return stream;
}
