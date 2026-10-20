import { spawn } from 'child_process';
import { Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';

export const DASHBOARD_CONTAINER_PORT = 4848;

/**
 * A byte stream to a port on the container's own loopback, carried over `docker exec`. The dashboard binds
 * 127.0.0.1 only; publishing it instead would expose it to every other container on the bridge network.
 */
export function openContainerLoopback(containerName: string, port: number): Duplex {
  const child = spawn(
    CONTAINER_RUNTIME_BIN,
    ['exec', '-i', containerName, 'bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3; wait`],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  child.stdin.on('error', () => {});
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on('close', () => child.kill());
  child.on('exit', () => stream.destroy());
  return stream;
}
