import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery seam for notify-owner.ts: every case here controls whether Slack
 * "answers" without ever reaching the network. `posts` records every call
 * `notifyOwner` made through the mocked seam, so a test can assert both the
 * outcome (exit code) and exactly what would have been sent (channel,
 * token, text) without a real HTTP request.
 */
const posts: { token: string; channel: string; text: string }[] = [];
let slackBehavior: 'ok' | 'ok-false' | 'network-error' = 'ok';

vi.mock('./channels/slack-lib.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./channels/slack-lib.js')>();
  return {
    ...actual,
    slackPostMessage: vi.fn(async (token: string, channel: string, text: string) => {
      posts.push({ token, channel, text });
      if (slackBehavior === 'ok-false') {
        throw new actual.SlackApiError('post-message', 'slack chat.postMessage failed: channel_not_found');
      }
      if (slackBehavior === 'network-error') {
        throw new actual.SlackApiError('post-message', 'slack chat.postMessage failed: fetch failed');
      }
    }),
  };
});

import { notifyOwner } from './notify-owner.js';
import { formatLocalStamp } from './timezone.js';

// A slug that cannot collide with a real bot token in any environment this
// suite runs in — botTokenKeyForChannelType derives SLACK_BOT_TOKEN_<SUFFIX>
// from it, and no real install configures this suffix.
const CHANNEL_TYPE = 'slack-notifyownertest';
const TOKEN_KEY = 'SLACK_BOT_TOKEN_NOTIFYOWNERTEST';
const FAKE_TOKEN = 'xoxb-test-fake-token-do-not-use';
const DISCORD_CHANNEL_TYPE = 'discord-notifyownertest';
const DISCORD_TOKEN_KEY = 'DISCORD_BOT_TOKEN_NOTIFYOWNERTEST';
const FAKE_DISCORD_TOKEN = 'discord-test-fake-token-do-not-use';

describe('src/notify-owner.ts', () => {
  let rootDir: string;
  let dataDir: string;
  let dbPath: string;

  beforeEach(() => {
    posts.length = 0;
    slackBehavior = 'ok';
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-root-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-db-'));
    dbPath = path.join(dataDir, 'v2.db');
    // Defensive: guarantee the ambient environment can never supply this
    // key, so a positive test's fixture .env is the only source of truth.
    vi.stubEnv(TOKEN_KEY, '');
    vi.stubEnv(DISCORD_TOKEN_KEY, '');
    vi.stubEnv('OPERATOR_ALERT_CHANNEL', '');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Minimal schema slice notify-owner.ts reads: messaging_groups/user_roles/user_dms. */
  function createDb(rows: { channelType: string; platformId: string }[]): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT, platform_id TEXT NOT NULL);
      CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE user_dms (
        user_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO user_roles (user_id, role) VALUES ('U1', 'owner')`).run();
    rows.forEach((r, i) => {
      const mgId = `mg${i}`;
      db.prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id) VALUES (?, ?, ?)`).run(
        mgId,
        r.channelType,
        r.platformId,
      );
      db.prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES ('U1', ?, ?, ?)`,
      ).run(r.channelType, mgId, new Date(2026, 0, 1, 0, 0, i).toISOString());
    });
    db.close();
  }

  it('(a) no owner DM row -> exit 2, nothing posted', async () => {
    createDb([]);
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/no owner dm/i);
    expect(posts).toHaveLength(0);
  });

  it('(b) no bot token configured -> exit 2, token key named but no token value anywhere', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    // rootDir has no .env, and the ambient env is stubbed empty (beforeEach).
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(2);
    expect(result.message).toContain(TOKEN_KEY);
    expect(posts).toHaveLength(0);
  });

  it('(c) Slack API returns ok:false -> exit 1, reason on message, token never appears', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    slackBehavior = 'ok-false';
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(1);
    expect(result.message).toContain('channel_not_found');
    expect(result.message).not.toContain(FAKE_TOKEN);
    expect(posts).toHaveLength(1);
  });

  it('(d) Slack API returns ok:true -> exit 0, safe channel id only, token never appears', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(0);
    expect(result.message).toBe(`delivered to ${CHANNEL_TYPE}:DTEST00001`);
    expect(result.message).not.toContain(FAKE_TOKEN);
    expect(posts).toEqual([{ token: FAKE_TOKEN, channel: 'DTEST00001', text: expect.any(String) }]);
  });

  it('(e) the DM text renders the timestamp in the install timezone, not UTC', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    const now = new Date('2026-01-15T20:30:00Z');
    const nyStamp = formatLocalStamp(now, 'America/New_York');
    const utcStamp = formatLocalStamp(now, 'UTC');
    expect(nyStamp).not.toBe(utcStamp); // sanity: the two zones must actually differ for this instant

    const result = await notifyOwner({
      title: 'Title',
      body: 'Body',
      dbPath,
      rootDir,
      timezone: 'America/New_York',
      now,
    });
    expect(result.code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(nyStamp);
    expect(posts[0]!.text).not.toContain(utcStamp);
  });

  it('(f) resolves the install from this file, not the caller cwd', async () => {
    // src/config.ts derives its paths from process.cwd(), so a caller that has
    // not cd'd would otherwise read a different install's DB and .env and exit
    // 2 ("no owner DM") exactly when an alert matters. The defaults must come
    // from the module's own location instead.
    const installRoot = path.resolve(__dirname, '..');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-cwd-'));
    const cwd = process.cwd();
    try {
      process.chdir(elsewhere);
      // Calling notifyOwner() with no dbPath used to be the oracle here, and it
      // was not hermetic: it reads `<install>/data/v2.db`, which is absent in a
      // fresh CI clone (giving the expected code 2) but PRESENT in a working
      // install — where the call resolved a real owner DM and DELIVERED the
      // fixture alert to it, then failed on `code` being 0.
      //
      // So the DB open is stubbed instead: `opened` records the path the
      // default actually reached, and the throw sends the run down the code-2
      // branch without any file or network. That keeps the oracle on the
      // WIRING (notify-owner.ts:136 passes OWNER_DB_PATH when no dbPath is
      // given), which asserting the exported constant alone does not prove.
      //
      // `vi.resetModules()` is load-bearing: without it the dynamic import
      // returns the instance the static import at the top of this file already
      // evaluated, whose constants were computed under the ORIGINAL cwd, so the
      // case passed even with the constants derived from process.cwd() — the
      // mutation Codex ran against this file and it survived. Re-evaluating
      // under `elsewhere` is what restores the kill. Asserting against
      // `elsewhere` rather than os.tmpdir() matters because the checkout itself
      // can live under /tmp (gate worktrees do), which made a cruder assertion
      // fail for the wrong reason.
      vi.resetModules();
      const opened: string[] = [];
      vi.doMock('better-sqlite3', () => ({
        default: class StubDatabase {
          constructor(file: string) {
            opened.push(file);
            throw new Error('stubbed: this case must never open a real central DB');
          }
        },
      }));
      const fresh = await import('./notify-owner.js');
      expect(fresh.OWNER_DB_PATH).toBe(path.join(installRoot, 'data', 'v2.db'));
      expect(fresh.INSTALL_ROOT).toBe(installRoot);

      const result = await fresh.notifyOwner({ title: 'T', body: 'B' });
      expect(opened).toEqual([path.join(installRoot, 'data', 'v2.db')]);
      expect(result.code).toBe(2);
      expect(result.message).not.toContain(elsewhere);
    } finally {
      vi.doUnmock('better-sqlite3');
      vi.resetModules();
      process.chdir(cwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('(g) falls through an unusable newest DM to an older one it can reach', async () => {
    // createDb stamps resolved_at by index, so the LAST entry is the newest.
    // Newest is a platform this script cannot post to; the older Slack row
    // has a token and must carry the alert instead of the run giving up.
    createDb([
      { channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00002' },
      { channelType: 'discord-notifyownertest', platformId: 'discord:@me:1234567890123456789' },
    ]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);

    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('DTEST00002');
  });

  it('(h) takes the timezone from the install root .env, not the ambient default', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\nTZ=America/New_York\n`);
    vi.stubEnv('TZ', ''); // process.env.TZ wins when set; empty forces the .env lookup

    const now = new Date('2026-01-15T20:30:00Z');
    const nyStamp = formatLocalStamp(now, 'America/New_York');
    const utcStamp = formatLocalStamp(now, 'UTC');
    expect(nyStamp).not.toBe(utcStamp);

    // No `timezone` option: the resolver must find TZ in rootDir/.env. Before
    // this, TIMEZONE came from src/config.ts, which reads ${process.cwd()}/.env
    // at import time — so a run from outside the checkout stamped UTC.
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, now });
    expect(result.code).toBe(0);
    expect(posts[0]!.text).toContain(nyStamp);
    expect(posts[0]!.text).not.toContain(utcStamp);
  });

  describe('OPERATOR_ALERT_CHANNEL', () => {
    const discordRequests: { url: string; init: RequestInit }[] = [];
    let discordStatus = 200;

    beforeEach(() => {
      discordRequests.length = 0;
      discordStatus = 200;
      vi.stubEnv('DISCORD_API_URL', 'http://discord.invalid/api');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          discordRequests.push({ url, init });
          return new Response('{}', { status: discordStatus });
        }),
      );
      createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
      const db = new Database(dbPath);
      db.prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id) VALUES (?, ?, ?)`).run(
        'mg-alerts',
        DISCORD_CHANNEL_TYPE,
        'discord:G-TEST:C-ALERTS',
      );
      db.close();
    });

    afterEach(() => vi.unstubAllGlobals());

    function writeEnv(alertChannel: string, withSlackToken = true): void {
      fs.writeFileSync(
        path.join(rootDir, '.env'),
        `OPERATOR_ALERT_CHANNEL=${alertChannel}\n${DISCORD_TOKEN_KEY}=${FAKE_DISCORD_TOKEN}\n` +
          (withSlackToken ? `${TOKEN_KEY}=${FAKE_TOKEN}\n` : ''),
      );
    }

    const notify = () => notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });

    it('posts to the configured Discord channel instead of the owner DM', async () => {
      writeEnv('mg-alerts');
      const result = await notify();
      expect(result).toEqual({ code: 0, message: `delivered to ${DISCORD_CHANNEL_TYPE}:C-ALERTS` });
      expect(posts).toHaveLength(0);
      expect(discordRequests).toHaveLength(1);
      const { url, init } = discordRequests[0]!;
      expect(url).toBe('http://discord.invalid/api/channels/C-ALERTS/messages');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${FAKE_DISCORD_TOKEN}`);
      const sent = JSON.parse(init.body as string) as { content: string; allowed_mentions: unknown };
      expect(sent.content.startsWith('**Title** (')).toBe(true);
      expect(sent.content.endsWith('\n\nBody')).toBe(true);
      expect(sent.allowed_mentions).toEqual({ parse: [] });
    });

    it('falls back to the owner DM when the channel post fails, and says why', async () => {
      writeEnv('mg-alerts');
      discordStatus = 500;
      const result = await notify();
      expect(result.code).toBe(0);
      expect(result.message).toBe(
        'OPERATOR_ALERT_CHANNEL=mg-alerts failed (discord channel message failed: HTTP 500); ' +
          `owner DM: delivered to ${CHANNEL_TYPE}:DTEST00001`,
      );
      expect(posts.map((p) => p.channel)).toEqual(['DTEST00001']);
    });

    it('falls back to the owner DM when the configured messaging group does not exist', async () => {
      writeEnv('mg-missing');
      const result = await notify();
      expect(result.code).toBe(0);
      expect(result.message).toContain('OPERATOR_ALERT_CHANNEL=mg-missing failed (no such messaging group)');
      expect(discordRequests).toHaveLength(0);
      expect(posts).toHaveLength(1);
    });

    it('reports a tried-and-failed channel as exit 1 even when no owner DM can be tried', async () => {
      writeEnv('mg-alerts', false);
      discordStatus = 403;
      const result = await notify();
      expect(result.code).toBe(1);
      expect(result.message).not.toContain(FAKE_DISCORD_TOKEN);
      expect(posts).toHaveLength(0);
    });

    it('redacts a token that native fetch quotes back in its header-validation error', async () => {
      vi.unstubAllGlobals(); // real fetch: it rejects the header before any connection is made
      const malformed = 'fake-discord-secret\nsecond-line';
      vi.stubEnv(DISCORD_TOKEN_KEY, malformed);
      writeEnv('mg-alerts');
      const result = await notify();
      expect(result.code).toBe(0);
      expect(result.message).toContain('OPERATOR_ALERT_CHANNEL=mg-alerts failed');
      expect(result.message).not.toContain('fake-discord-secret');
      expect(posts).toHaveLength(1);
    });

    it('an unreadable .env with the key unset still reaches the owner DM rather than throwing', async () => {
      fs.mkdirSync(path.join(rootDir, '.env'));
      vi.stubEnv(TOKEN_KEY, FAKE_TOKEN);
      const result = await notify();
      expect(result).toEqual({ code: 0, message: `delivered to ${CHANNEL_TYPE}:DTEST00001` });
    });
  });
});
