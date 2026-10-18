import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeAgentRunnerDepsHash } from '../src/agent-runner-image-check.js';
import { buildAgentImage } from './container.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_INPUTS = [
  'container/build.sh',
  'setup/lib/install-slug.sh',
  'container/agent-runner/package.json',
  'container/agent-runner/bun.lock',
];

describe('buildAgentImage', () => {
  let root: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stamps the agent-runner deps hash the spawn gate compares against', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-container-build-'));
    for (const rel of BUILD_INPUTS) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    const bin = path.join(root, 'bin');
    const argsFile = path.join(root, 'docker-args');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('CONTAINER_RUNTIME', 'docker');

    expect(buildAgentImage(root, 'example-agent:latest')).toBe(0);

    const args = fs.readFileSync(argsFile, 'utf8').split('\n');
    expect(args).toContain(`AGENT_RUNNER_DEPS_HASH=${await computeAgentRunnerDepsHash()}`);
    expect(args[args.indexOf('-t') + 1]).toBe('example-agent:latest');
  });
});
