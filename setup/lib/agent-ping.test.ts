import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { classifyPingResult, describePingFailure, setupClosing } from './agent-ping.js';

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(
      classifyPingResult(0, 'Invalid API key · Please run /login'),
    ).toBe('auth_error');
    expect(
      classifyPingResult(0, 'Not logged in · Please run /login'),
    ).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
  });

  it("treats the agent-runner's turn-error reply as a failure, not a pong", () => {
    const runner = fs.readFileSync(new URL('../../container/agent-runner/src/poll-loop.ts', import.meta.url), 'utf8');
    const replies = [...runner.matchAll(/`([^`]*Turn ended with an error:[^`]*)`/g)].map(([, text]) =>
      text.replace(/\$\{[^}]*\}/g, 'codex_system_error: thread entered systemError state'),
    );
    // Both turn-error sites; a reworded one drops out of this match and fails the count.
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(classifyPingResult(0, `> nanoclaw@1.0.0 chat\n> tsx scripts/chat.ts ping\n\n${reply}\n`)).toBe(
        'agent_error',
      );
    }
  });

  it('still counts a reply that quotes an earlier turn error as a pong', () => {
    expect(classifyPingResult(0, 'Pong.\n> Turn ended with an error: old failure\nThe current turn succeeded.\n')).toBe(
      'ok',
    );
  });
});

describe('describePingFailure', () => {
  it('tells a user with no provider credentials to sign in, not that the reply was late', () => {
    const { headline, note } = describePingFailure('auth_error');
    expect(headline).toMatch(/no credentials/i);
    expect(headline).not.toMatch(/in time/);
    expect(note).toMatch(/sign in to your provider/i);
  });
});

describe('setupClosing', () => {
  it('does not call setup ready when the ping failed, and points at the fix already shown', () => {
    for (const failure of ['auth_error', 'no_reply', 'socket_error', 'agent_error'] as const) {
      for (const dmTarget of [null, 'Telegram']) {
        const { ready, text } = setupClosing(failure, dmTarget);
        expect(ready).toBe(false);
        expect(text).not.toMatch(/ready|you're set/i);
        expect(text).toContain(describePingFailure(failure).headline);
      }
    }
  });

  it('keeps the ready line when the ping answered or never ran', () => {
    expect(setupClosing('ok', null)).toEqual({ ready: true, text: "You're ready! Chat with `pnpm run chat hi`." });
    expect(setupClosing(undefined, 'Telegram')).toEqual({ ready: true, text: "You're set." });
  });
});
