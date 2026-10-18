import { describe, expect, it } from 'vitest';

import { findOrCreateAgentGroup } from './bootstrap-agent-group.js';

describe('findOrCreateAgentGroup', () => {
  it('refuses a folder the host cannot run before it touches the database', async () => {
    await expect(findOrCreateAgentGroup('_ping-test', 'Terminal Agent', new Date().toISOString())).rejects.toThrow(
      'Invalid group folder "_ping-test"',
    );
  });
});
