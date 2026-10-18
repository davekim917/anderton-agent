import { spawnSync } from 'child_process';

/**
 * Distro `docker.io` packages ship without the buildx and compose plugins: the image build needs buildx (the
 * Dockerfile uses `RUN --mount`), and the local OneCLI vault install needs compose.
 */
export function dockerHasPlugin(
  plugin: 'buildx' | 'compose',
  probe: (args: string[]) => number | null = (args) => spawnSync('docker', args, { stdio: 'ignore' }).status,
): boolean {
  return probe([plugin, 'version']) === 0;
}
