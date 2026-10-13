import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('credential-ownership-test') }));
const DATA_DIR = path.join(TEST_ROOT, 'data');
const HOME = path.join(TEST_ROOT, 'home');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

import {
  CREDENTIAL_OWNERSHIP_POLICY_PATH,
  GMAIL_PRIMARY_SCOPE,
  hostCredentialScopes,
  loadCredentialOwnership,
  parseCredentialOwnership,
  stagedCredentialScopes,
} from './credential-ownership.js';

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('loadCredentialOwnership', () => {
  it('is null when there is no policy file, and reads kind → scope → workgroups when there is', () => {
    expect(CREDENTIAL_OWNERSHIP_POLICY_PATH).toBe(path.join(DATA_DIR, 'credential-ownership.json'));
    expect(loadCredentialOwnership()).toBeNull();
    write(
      CREDENTIAL_OWNERSHIP_POLICY_PATH,
      JSON.stringify({ version: 1, credentials: { aws: { 'prod-a': ['client-a', 'hub'], retired: [] } } }),
    );
    const aws = loadCredentialOwnership()?.get('aws');
    expect([...(aws?.get('prod-a') ?? [])]).toEqual(['client-a', 'hub']);
    expect([...(aws?.get('retired') ?? [])]).toEqual([]);
  });

  it.each([
    ['unparseable JSON', '{', /JSON parse failed/],
    ['an unknown top-level key', { version: 1, credentials: {}, extra: 1 }, /only version and credentials/],
    ['a wrong version', { version: 2, credentials: {} }, /version must be 1/],
    ['credentials as an array', { version: 1, credentials: [] }, /credentials must be an object/],
    ['an unknown kind', { version: 1, credentials: { ssh: {} } }, /"ssh" is not a credential kind/],
    ['a traversing scope', { version: 1, credentials: { aws: { '..': ['a'] } } }, /not a credential scope name/],
    ['a scope with a separator', { version: 1, credentials: { aws: { 'a/b': ['a'] } } }, /not a credential scope/],
    ['owners not an array', { version: 1, credentials: { aws: { x: 'hub' } } }, /must map to an array/],
    ['an owner that is not a slug', { version: 1, credentials: { aws: { x: ['Hub'] } } }, /not a workgroup slug/],
  ])('throws on %s rather than guessing', (_label, policy, message) => {
    expect(() => parseCredentialOwnership(typeof policy === 'string' ? policy : JSON.stringify(policy))).toThrow(
      message,
    );
  });

  it.each([
    ['unparseable JSON', '{'],
    ['an invalid policy', JSON.stringify({ version: 2, credentials: {} })],
  ])('names the file it was given, not the installed path, on %s', (_label, contents) => {
    const proposed = path.join(TEST_ROOT, 'proposed.json');
    write(proposed, contents);
    expect(() => loadCredentialOwnership(proposed)).toThrow(`Invalid credential ownership policy at ${proposed}:`);
  });
});

describe('stagedCredentialScopes', () => {
  const ownership = parseCredentialOwnership(
    JSON.stringify({
      version: 1,
      credentials: { aws: { 'client-a': ['client-a', 'hub'], 'client-b': ['client-b', 'hub'], sealed: [] } },
    }),
  );
  const available = (): string[] => ['client-a', 'client-b', 'sealed', 'shared'];

  // With a policy file staging fails closed: an unowned scope (`shared`) and every scope of an unnamed kind reach no
  // workgroup, and a bare tool is staged scope by scope even for a workgroup that owns every owned scope.
  it.each([
    ['a kind the policy does not name stages nothing', 'snowflake', 'client-b', ['snowflake'], []],
    [
      'a scoped request drops scopes the workgroup does not own',
      'aws',
      'client-a',
      ['aws:client-a', 'aws:client-b', 'aws:shared'],
      ['client-a'],
    ],
    ['a bare tool narrows to the scopes the workgroup owns', 'aws', 'client-a', ['aws'], ['client-a']],
    ['a member with no tools list narrows like a bare tool', 'aws', 'hub', undefined, ['client-a', 'client-b']],
    ['an empty owner list reaches no workgroup', 'aws', 'other', ['aws:sealed'], []],
  ] as const)('%s', (_label, kind, workgroup, tools, expected) => {
    expect(stagedCredentialScopes(kind, tools ? [...tools] : undefined, workgroup, ownership, available)).toEqual({
      scopes: expected,
      isScoped: true,
    });
  });

  it('stages nothing for a tool that is off, and without a policy keeps the request as it is', () => {
    expect(stagedCredentialScopes('aws', ['snowflake'], 'hub', ownership, available)).toBeNull();
    const listed = vi.fn(available);
    expect(stagedCredentialScopes('aws', ['aws'], 'hub', null, listed)).toEqual({ scopes: [], isScoped: false });
    expect(stagedCredentialScopes('aws', undefined, 'hub', null, listed)).toEqual({ scopes: [], isScoped: false });
    expect(stagedCredentialScopes('aws', ['aws:client-b'], 'hub', null, listed)).toEqual({
      scopes: ['client-b'],
      isScoped: true,
    });
    expect(listed).not.toHaveBeenCalled();
  });

  it('selects email-named workspace MCP files by the google-workspace scope prefix, then by ownership', () => {
    const stems = (): string[] => ['pat@acme1.com', 'ops@acme1.com', 'pat@acme2.com'];
    const policy = parseCredentialOwnership(
      JSON.stringify({ version: 1, credentials: { 'google-workspace-mcp': { 'pat@acme1.com': ['client-a'] } } }),
    );
    expect(stagedCredentialScopes('google-workspace-mcp', ['google-workspace:pat'], 'x', null, stems)).toEqual({
      scopes: ['pat@acme1.com', 'pat@acme2.com'],
      isScoped: true,
    });
    expect(stagedCredentialScopes('google-workspace-mcp', ['google-workspace'], 'client-a', policy, stems)).toEqual({
      scopes: ['pat@acme1.com'],
      isScoped: true,
    });
    expect(stagedCredentialScopes('google-workspace-mcp', ['snowflake'], 'client-a', policy, stems)).toBeNull();
  });

  describe('gmail', () => {
    const accounts = (): string[] => ['client-a', GMAIL_PRIMARY_SCOPE, 'client-b'];
    const policy = parseCredentialOwnership(
      JSON.stringify({
        version: 1,
        credentials: {
          gmail: { [GMAIL_PRIMARY_SCOPE]: ['hub'], 'client-a': ['client-a', 'hub'], 'client-b': ['hub'] },
        },
      }),
    );

    it('keeps the primary account at the primary path when it is staged, never a reordered other account', () => {
      expect(stagedCredentialScopes('gmail', ['gmail'], 'hub', policy, accounts)).toEqual({
        scopes: ['client-a', GMAIL_PRIMARY_SCOPE, 'client-b'],
        isScoped: true,
        primary: GMAIL_PRIMARY_SCOPE,
      });
      expect(stagedCredentialScopes('gmail', ['gmail'], 'client-a', policy, accounts)).toEqual({
        scopes: ['client-a'],
        isScoped: true,
      });
    });

    it('gives the primary path to the first requested account only while it is staged', () => {
      expect(
        stagedCredentialScopes('gmail', ['gmail-readonly:client-b', 'gmail:client-a'], 'x', null, accounts),
      ).toEqual({ scopes: ['client-a', 'client-b'], isScoped: true, primary: 'client-a' });
      expect(
        stagedCredentialScopes('gmail', ['gmail:client-b', 'gmail-readonly:client-a'], 'client-a', policy, accounts),
      ).toEqual({ scopes: ['client-a'], isScoped: true });
    });
  });
});

describe('hostCredentialScopes', () => {
  it('names each store’s scopes the way its staging selects them', () => {
    write(path.join(HOME, '.aws', 'credentials'), '[default]\nk = 1\n[client-a]\nk = 2\n');
    write(path.join(HOME, '.aws', 'config'), '[default]\n[profile client-a]\n[profile config-only]\n');
    write(path.join(HOME, '.config', 'gws', 'accounts', 'client-a.json'), '{}');
    write(path.join(HOME, '.config', 'gws', 'accounts', 'client-a.json.bak'), '{}');
    fs.mkdirSync(path.join(HOME, '.config', 'gws', 'accounts', 'dir-account'), { recursive: true });
    write(path.join(HOME, '.google_workspace_mcp', 'credentials', 'pat@acme1.com.json'), '{}');
    for (const dir of ['.gmail-mcp', '.gmail-mcp-client-a', `.gmail-mcp-${GMAIL_PRIMARY_SCOPE}`])
      fs.mkdirSync(path.join(HOME, dir), { recursive: true });
    write(path.join(HOME, '.gmail-mcp-file'), '');
    write(path.join(HOME, '.google_workspace_mcp', 'credentials', 'pat@acme1.com.json.gws'), '{}');
    write(
      path.join(HOME, '.dbt', 'profiles.yml'),
      'client_a:\n  target: dev\nconfig:\n  send_anonymous_usage_stats: false\n',
    );

    expect(hostCredentialScopes('aws', HOME).sort()).toEqual(['client-a', 'config-only', 'default']);
    expect(hostCredentialScopes('google-workspace', HOME).sort()).toEqual(['client-a', 'dir-account']);
    expect(hostCredentialScopes('google-workspace-mcp', HOME)).toEqual(['pat@acme1.com']);
    // The reserved name is only ever the unsuffixed account, even when a suffix directory spells it.
    expect(hostCredentialScopes('gmail', HOME).sort()).toEqual([GMAIL_PRIMARY_SCOPE, 'client-a']);
    expect(hostCredentialScopes('dbt', HOME).sort()).toEqual(['client_a', 'config']);
    expect(hostCredentialScopes('gcloud', HOME, { GCLOUD_KEY_CLIENT_A: 'a.json', OTHER: 'x' })).toEqual(['client_a']);
    expect(hostCredentialScopes('snowflake', HOME)).toEqual([]);
  });
});
