import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { compareVersions } from '../src/container-updates.js';
import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['jq']);
enforceHermeticity();

describe('agent image jq', () => {
  // The container skill scripts' shell suites run under the jq on this PATH, so
  // that version is what their jq programs are proven against; an image jq older
  // than it can fail to compile them inside an agent container.
  it('ships a jq no older than the one the container scripts are tested under', () => {
    const dockerfile = readFileSync(path.resolve(import.meta.dirname, 'Dockerfile'), 'utf8');
    const pinned = dockerfile.match(/^ARG JQ_VERSION=(\d+(?:\.\d+)*)\s*$/m)?.[1];
    expect(pinned, 'container/Dockerfile must pin jq as ARG JQ_VERSION').toBeDefined();
    expect(dockerfile).toContain('[ "$(/usr/local/bin/jq --version)" = "jq-${JQ_VERSION}" ]');

    const tested = execFileSync('jq', ['--version'], { encoding: 'utf8' }).trim();
    expect(tested, 'could not read the version of the jq on PATH').toMatch(/^jq-\d+(?:\.\d+)+/);
    expect(
      compareVersions(pinned!, tested),
      `image jq ${pinned} is older than ${tested}, the jq the container scripts are tested under`,
    ).toBeGreaterThanOrEqual(0);
  });
});
