import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { textEdit, VIEWER_PAGE, virtualKeyCode } from './viewer.js';

describe('virtualKeyCode', () => {
  it.each([
    ['a', 65],
    ['Z', 90],
    ['7', 55],
    ['.', 0],
    ['@', 0],
    ['-', 0],
    [' ', 0],
  ])('maps %j to %i, never to a key code that means something else (46 is Delete)', (c, code) => {
    expect(virtualKeyCode(c)).toBe(code);
  });
});

describe('textEdit', () => {
  it.each([
    ['', 'a.b', { deletes: 0, inserts: 'a.b' }],
    ['abc', 'abcd', { deletes: 0, inserts: 'd' }],
    ['abcd', 'ab', { deletes: 2, inserts: '' }],
    ['hello wrold', 'hello world', { deletes: 4, inserts: 'orld' }],
    ['same', 'same', { deletes: 0, inserts: '' }],
    ['pass😀', 'pass', { deletes: 1, inserts: '' }],
    ['pass😀', 'pass😃', { deletes: 1, inserts: '😃' }],
    ['ab👨‍👩‍👧‍👦', 'ab', { deletes: 1, inserts: '' }],
    ['ab🇺🇸', 'ab🇨🇦', { deletes: 1, inserts: '🇨🇦' }],
    ['cafe\u0301', 'caf', { deletes: 2, inserts: '' }],
    ['\u0915\u094D\u0937', '\u0915', { deletes: 2, inserts: '' }],
  ])('turns %j into %j', (prev, cur, edit) => {
    expect(textEdit(prev, cur)).toEqual(edit);
  });
});

describe('VIEWER_PAGE', () => {
  it('starts the type-in box masked, so a phone keyboard treats it as a password', () => {
    expect(VIEWER_PAGE).toMatch(/<input id="t" type="password"/);
  });

  it('inlines the same two functions the tests above exercise, as a parseable script', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(VIEWER_PAGE)?.[1] ?? '';
    expect(script).toContain(virtualKeyCode.toString());
    expect(script).toContain(textEdit.toString());
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('agent-browser stream contract', () => {
  it('is pinned to the version whose frame, status, input_mouse and input_keyboard messages the viewer was verified against', () => {
    // A bump must rerun the phone takeover end to end (docs/browser-takeover.md) before moving this pin.
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^ARG AGENT_BROWSER_VERSION=0\.38\.2$/m);
  });
});
