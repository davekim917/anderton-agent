import { describe, expect, it } from 'vitest';

import { GMAIL_PRIMARY_SCOPE, parseCredentialOwnership } from '../src/credential-ownership.js';
import { diffMember, unownedScopes, type HostInventory } from './credential-ownership-dry-run.js';

const inventory: HostInventory = {
  'google-workspace': ['client-a', 'personal'],
  'google-workspace-mcp': ['pat@acme1.com', 'pat@example.org'],
  gmail: [GMAIL_PRIMARY_SCOPE, 'client-a'],
  calendar: [],
  snowflake: ['client-a', 'helios'],
  aws: ['client-a', 'default'],
  dbt: [],
  gcloud: [],
};

const proposed = parseCredentialOwnership(
  JSON.stringify({
    version: 1,
    credentials: {
      'google-workspace': { 'client-a': ['client-a', 'hub'], personal: ['hub', 'side'] },
      'google-workspace-mcp': { 'pat@acme1.com': ['client-a', 'hub'] },
      gmail: { [GMAIL_PRIMARY_SCOPE]: ['hub'], 'client-a': ['client-a', 'hub'] },
      snowflake: { 'client-a': ['client-a', 'side'] },
      aws: { 'client-a': ['client-a', 'side'], default: ['side'] },
    },
  }),
);

describe('credential ownership dry run', () => {
  // A policy fails closed, so even an owner of every scope loses the whole-store mount (`*`) and the unowned scopes.
  it('reports what each member loses as the spawn would stage it', () => {
    const tools = ['google-workspace', 'snowflake:client-a', 'aws'];
    expect(diffMember({ folder: 'side', workgroupId: 'side', tools }, null, proposed, inventory)).toEqual({
      folder: 'side',
      lost: [
        'aws:*',
        'google-workspace-mcp:*',
        'google-workspace-mcp:pat@acme1.com',
        'google-workspace-mcp:pat@example.org',
        'google-workspace:*',
        'google-workspace:client-a',
      ],
      gained: [],
    });
    expect(
      diffMember({ folder: 'hub', workgroupId: 'hub', tools: ['google-workspace'] }, null, proposed, inventory),
    ).toEqual({
      folder: 'hub',
      lost: ['google-workspace-mcp:*', 'google-workspace-mcp:pat@example.org', 'google-workspace:*'],
      gained: [],
    });
    // An unrestricted member is narrowed like a bare tool: here it reaches nothing it does not own.
    expect(
      diffMember({ folder: 'free', workgroupId: 'other', tools: undefined }, null, proposed, inventory).lost,
    ).toEqual(
      expect.arrayContaining([
        'aws:client-a',
        'aws:default',
        'snowflake:client-a',
        'google-workspace:personal',
        `gmail:${GMAIL_PRIMARY_SCOPE}`,
        'gmail:client-a',
      ]),
    );
    expect(unownedScopes(proposed, inventory)).toEqual(['google-workspace-mcp:pat@example.org', 'snowflake:helios']);
  });
});
