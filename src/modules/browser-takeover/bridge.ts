import { spawn } from 'child_process';
import { Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';

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
  stream.on('close', () => child.kill());
  child.on('exit', () => stream.destroy());
  return stream;
}
