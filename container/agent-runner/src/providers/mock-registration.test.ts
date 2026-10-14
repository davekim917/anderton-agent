import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import { allowSubprocess } from '../test-hermeticity.js';

allowSubprocess([path.basename(process.execPath)]);

// A fresh process: in the shared test process other files import ./mock.js directly, which would register it anyway.
function providersRegisteredByBarrelAlone(): string[] {
  const dir = import.meta.dir;
  const script = [
    `await import(${JSON.stringify(path.join(dir, 'index.ts'))});`,
    `const { listProviderNames } = await import(${JSON.stringify(path.join(dir, 'provider-registry.ts'))});`,
    `console.log(JSON.stringify(listProviderNames()));`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '[]') as string[];
}

describe('mock provider registration', () => {
  it('registers mock via the provider barrel', () => {
    expect(providersRegisteredByBarrelAlone()).toContain('mock');
  });
});
