import os from 'os';
import { describe, expect, it } from 'vitest';

import { currentUserName } from './current-user.js';

describe('currentUserName', () => {
  it('falls back to the passwd entry when USER is unset or blank', () => {
    expect(currentUserName({})).toBe(os.userInfo().username);
    expect(currentUserName({ USER: '  ' })).toBe(os.userInfo().username);
  });

  it('uses USER when it is set', () => {
    expect(currentUserName({ USER: 'stranger' })).toBe('stranger');
  });
});
