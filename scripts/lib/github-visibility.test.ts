import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cachedGithubVisibility,
  parseVisibilityResponse,
  type GithubRepository,
  type VisibilityLookup,
  type VisibilityVerdict,
} from './github-visibility.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function cachePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-visibility-'));
  roots.push(root);
  return path.join(root, '.nanoclaw', 'cache.json');
}

const kit: GithubRepository = { owner: 'Open-Org', repo: 'Sprocket-Kit' };
const widget: GithubRepository = { owner: 'acme-co', repo: 'widget' };

function scriptedLookup(answers: Record<string, VisibilityVerdict>): VisibilityLookup & { asked: string[][] } {
  const asked: string[][] = [];
  const lookup: VisibilityLookup = (repositories) => {
    const keys = repositories.map((repository) => `${repository.owner}/${repository.repo}`.toLowerCase());
    asked.push(keys);
    return new Map(keys.flatMap((key) => (answers[key] ? [[key, answers[key]] as const] : [])));
  };
  return Object.assign(lookup, { asked });
}

const DAY = 24 * 60 * 60 * 1000;

describe('cachedGithubVisibility', () => {
  it('is public only on a public answer, and a later scan asks nothing', () => {
    const file = cachePath();
    const lookup = scriptedLookup({ 'open-org/sprocket-kit': 'public', 'acme-co/widget': 'not_found' });
    const resolve = cachedGithubVisibility({ cachePath: file, lookup, now: () => 1_000 * DAY });
    expect(resolve([kit, widget])).toEqual(new Set(['open-org/sprocket-kit']));
    expect(resolve([kit, widget])).toEqual(new Set(['open-org/sprocket-kit']));
    expect(lookup.asked).toEqual([['open-org/sprocket-kit', 'acme-co/widget']]);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/widget|sprocket/i);
  });

  it.each<[VisibilityVerdict | 'unanswered', number, boolean]>([
    ['public', 6 * DAY, false],
    ['public', 8 * DAY, true],
    ['private', 6 * DAY, false],
    ['private', 8 * DAY, true],
    ['not_found', 0.5 * DAY, false],
    ['not_found', 2 * DAY, true],
    ['unanswered', (0.5 / 24) * DAY, false],
    ['unanswered', (2 / 24) * DAY, true],
  ])('a %s verdict %d ms old is asked again: %s', (verdict, age, askedAgain) => {
    const file = cachePath();
    let now = 1_000 * DAY;
    const first = scriptedLookup(verdict === 'unanswered' ? {} : { 'acme-co/widget': verdict });
    cachedGithubVisibility({ cachePath: file, lookup: first, now: () => now })([widget]);
    now += age;
    const second = scriptedLookup({ 'acme-co/widget': 'public' });
    const proven = cachedGithubVisibility({ cachePath: file, lookup: second, now: () => now })([widget]);
    expect(second.asked.length > 0).toBe(askedAgain);
    expect(proven.has('acme-co/widget')).toBe(askedAgain || verdict === 'public');
  });

  it('never proves a repository public when the lookup throws, and caches that as a failure', () => {
    const file = cachePath();
    const throwing: VisibilityLookup = () => {
      throw new Error('gh missing');
    };
    expect(cachedGithubVisibility({ cachePath: file, lookup: throwing, now: () => DAY })([kit])).toEqual(new Set());
    const later = scriptedLookup({ 'open-org/sprocket-kit': 'public' });
    expect(cachedGithubVisibility({ cachePath: file, lookup: later, now: () => DAY + 60_000 })([kit])).toEqual(
      new Set(),
    );
    expect(later.asked).toEqual([]);
  });

  it('distrusts a cache stamp from the future', () => {
    const file = cachePath();
    cachedGithubVisibility({
      cachePath: file,
      lookup: scriptedLookup({ 'open-org/sprocket-kit': 'public' }),
      now: () => 10 * DAY,
    })([kit]);
    const second = scriptedLookup({ 'open-org/sprocket-kit': 'private' });
    expect(cachedGithubVisibility({ cachePath: file, lookup: second, now: () => 5 * DAY })([kit])).toEqual(new Set());
    expect(second.asked).toHaveLength(1);
  });

  it.each([
    ['an entry without a stamp', '{"version":1,"entries":{"x":{"verdict":"public"}}}'],
    ['a JSON null', 'null'],
    ['a list', '[]'],
  ])('ignores a cache that is %s, asks again, and rewrites it', (_, text) => {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const lookup = scriptedLookup({});
    expect(cachedGithubVisibility({ cachePath: file, lookup, now: () => DAY })([kit])).toEqual(new Set());
    expect(lookup.asked).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('stops asking once the scan budget is spent, leaving the rest private', () => {
    const file = cachePath();
    const many = Array.from({ length: 150 }, (_, i) => ({ owner: 'open-org', repo: `kit-${i}` }));
    let now = DAY;
    const timeouts: number[] = [];
    const slow: VisibilityLookup = (repositories, timeoutMs) => {
      timeouts.push(timeoutMs);
      now += 9_000;
      return new Map(repositories.map((repository) => [`open-org/${repository.repo}`, 'public' as const]));
    };
    const proven = cachedGithubVisibility({ cachePath: file, lookup: slow, now: () => now, budgetMs: 8_000 })(many);
    expect(timeouts).toEqual([5_000]);
    expect(proven.size).toBe(100);
  });
});

describe('parseVisibilityResponse', () => {
  const repositories = [kit, widget, { owner: 'old-org', repo: 'moved' }, { owner: 'acme-co', repo: 'gone' }];

  it('reads public, private, renamed and not-found answers, and leaves an unexplained null out', () => {
    const body = JSON.stringify({
      data: {
        r0: { nameWithOwner: 'open-org/sprocket-kit', isPrivate: false, visibility: 'PUBLIC' },
        r1: { nameWithOwner: 'acme-co/widget', isPrivate: true, visibility: 'PRIVATE' },
        r2: { nameWithOwner: 'new-org/moved', isPrivate: false, visibility: 'PUBLIC' },
        r3: null,
      },
      errors: [{ type: 'NOT_FOUND', path: ['r3'] }],
    });
    expect(parseVisibilityResponse(repositories, body)).toEqual(
      new Map([
        ['open-org/sprocket-kit', 'public'],
        ['acme-co/widget', 'private'],
        ['old-org/moved', 'private'],
        ['acme-co/gone', 'not_found'],
      ]),
    );
    const nullWithoutReason = JSON.stringify({ data: { r0: null }, errors: [{ type: 'RATE_LIMITED', path: ['r0'] }] });
    expect(parseVisibilityResponse([kit], nullWithoutReason)).toEqual(new Map());
  });

  it.each([
    ['internal visibility', { nameWithOwner: 'open-org/sprocket-kit', isPrivate: false, visibility: 'INTERNAL' }],
    ['a missing isPrivate', { nameWithOwner: 'open-org/sprocket-kit', visibility: 'PUBLIC' }],
  ])('does not call %s public', (_, node) => {
    expect(parseVisibilityResponse([kit], JSON.stringify({ data: { r0: node } }))).toEqual(
      new Map([['open-org/sprocket-kit', 'private']]),
    );
  });

  it('places nothing from a body that is not a GraphQL answer', () => {
    expect(parseVisibilityResponse([kit], 'gh: authentication required')).toEqual(new Map());
    expect(parseVisibilityResponse([kit], 'null')).toEqual(new Map());
  });
});
