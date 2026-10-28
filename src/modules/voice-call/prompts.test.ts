import { describe, expect, it } from 'vitest';

import { groupRequestText } from './prompts.js';

describe('groupRequestText', () => {
  it('keeps both the start and the end of a relay too long for one message', () => {
    const request = `Pixel, stop the production deploy. ${'Lunch talk. '.repeat(600)}Pixel, then check the nightly.`;
    const text = groupRequestText({ speaker: null, request, first: false });
    expect(text).toContain('Pixel, stop the production deploy.');
    expect(text).toContain('Pixel, then check the nightly.');
    expect(text).toContain('…truncated…');
  });
});
