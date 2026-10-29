import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  getStored, setStored, upsertProfile, deleteProfile, importProfiles, addBlacklist, isBlacklisted,
  clearAll, emptyStored, isProfile, touchProfile,
} from '../src/lib/storage';
import type { LoginProfile, IdentityProfile, Stored } from '../src/lib/types';
import { installChromeMock, type Harness } from './helpers/chrome-mock';

let h: Harness;
beforeAll(() => { h = installChromeMock(); });

function login(id: string, url = 'https://a.example'): LoginProfile {
  return { id, kind: 'login', url, username: 'u', password: 'p', updatedAt: 0 };
}
function ident(id: string): IdentityProfile {
  return { id, kind: 'identity', label: 'L', fields: { email: 'x@y.z' }, updatedAt: 0 };
}

beforeEach(() => { h.store.clear(); });

describe('storage', () => {
  it('returns an empty store when nothing exists', async () => {
    const s = await getStored();
    expect(s.version).toBe(1);
    expect(s.profiles).toEqual([]);
    expect(s.blacklist).toEqual([]);
  });

  it('round-trips a stored value', async () => {
    const p = login('1');
    await setStored({ version: 1, profiles: [p], blacklist: [] });
    const s = await getStored();
    expect(s.profiles).toEqual([p]);
  });

  it('preserves and rejects unknown version', async () => {
    await setStored({ version: 99 as unknown as 1, profiles: [], blacklist: [] } as unknown as Stored);
    await expect(getStored()).rejects.toThrow('格式异常');
  });

  it('upsertProfile inserts and updates', async () => {
    await upsertProfile(login('1'));
    await upsertProfile(login('1', 'https://b.example'));
    const s = await getStored();
    expect(s.profiles).toHaveLength(1);
    expect((s.profiles[0] as LoginProfile).url).toBe('https://b.example');
  });

  it('deleteProfile removes by id', async () => {
    await upsertProfile(login('1'));
    await upsertProfile(ident('2'));
    await deleteProfile('1');
    const s = await getStored();
    expect(s.profiles.map((p) => p.id)).toEqual(['2']);
  });

  it('addBlacklist dedupes', async () => {
    await addBlacklist('https://x.example');
    await addBlacklist('https://x.example');
    const s = await getStored();
    expect(s.blacklist).toEqual(['https://x.example']);
    expect(await isBlacklisted('https://x.example')).toBe(true);
  });

  it('importProfiles merges by id (incoming wins)', async () => {
    await upsertProfile(login('1', 'https://old.example'));
    const res = await importProfiles([login('1', 'https://new.example'), ident('2')]);
    expect(res.imported).toBe(2);
    expect(res.rejected).toBe(0);
    const s = await getStored();
    expect(s.profiles).toHaveLength(2);
    const l = s.profiles.find((p) => p.id === '1') as LoginProfile;
    expect(l.url).toBe('https://new.example');
  });
});

describe('storage — the empty store must not be a shared, mutable constant', () => {
  it('hands out independent arrays on every call', () => {
    const a = emptyStored();
    a.profiles.push(login('x'));
    a.blacklist.push('https://x.example');
    expect(emptyStored().profiles).toEqual([]);
    expect(emptyStored().blacklist).toEqual([]);
  });

  it('clearAll really wipes everything (asserted against a literal)', async () => {
    await upsertProfile(login('1'));
    await addBlacklist('https://x.example');
    await clearAll();
    expect(await getStored()).toEqual({ version: 1, profiles: [], blacklist: [] });
  });

  it('a write on an empty store cannot corrupt a later empty read', async () => {
    await upsertProfile(login('1'));
    expect(emptyStored().profiles).toEqual([]);
  });
});

describe('storage — concurrent writes', () => {
  it('does not lose an update when two upserts overlap', async () => {
    await setStored({ version: 1, profiles: [login('seed')], blacklist: [] });
    const release = h.gateNextGets(2);          // both reads observe the pre-write state
    const a = upsertProfile(login('A'));
    const b = upsertProfile(login('B'));
    release();
    await Promise.all([a, b]);
    const ids = (await getStored()).profiles.map((p) => p.id).sort();
    expect(ids).toEqual(['A', 'B', 'seed']);
  });

  it('serialises a blacklist add against an upsert', async () => {
    const release = h.gateNextGets(2);
    const p1 = upsertProfile(login('A'));
    const p2 = addBlacklist('https://x.example');
    release();
    await Promise.all([p1, p2]);
    const s = await getStored();
    expect(s.profiles.map((p) => p.id)).toEqual(['A']);
    expect(s.blacklist).toEqual(['https://x.example']);
  });
});

describe('storage — import validation', () => {
  it('rejects rows that are not valid profiles and reports the count', async () => {
    const res = await importProfiles([
      { id: 'bad1', kind: 'identity' },     // no fields
      { id: 'bad2', kind: 'login' },        // no url/username/password
      { id: 'bad3' },                       // no kind
      'nonsense',
      null,
      ident('ok'),
    ] as unknown[]);
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(5);
    expect((await getStored()).profiles.map((p) => p.id)).toEqual(['ok']);
  });

  it('guards the shape of a single record', () => {
    expect(isProfile(login('1'))).toBe(true);
    expect(isProfile(ident('2'))).toBe(true);
    expect(isProfile({ id: 'x', kind: 'identity' })).toBe(false);
    expect(isProfile(null)).toBe(false);
    expect(isProfile({ ...login('1'), url: 42 })).toBe(false);
    expect(isProfile({ ...ident('2'), fields: { 'some-unknown-field': 'important data' } })).toBe(false);
    expect(isProfile({ ...ident('2'), fields: { 'current-password': 'must-not-enter-identity' } })).toBe(false);
  });

  it('rejects unknown or credential identity field keys instead of silently dropping them', async () => {
    const unknown = { ...ident('unknown'), fields: { 'some-unknown-field': 'important data' } } as unknown;
    const credential = { ...ident('credential'), fields: { username: 'synthetic-user' } } as unknown;
    const result = await importProfiles([unknown, credential, ident('ok')]);
    expect(result.imported).toBe(1);
    expect(result.rejected).toBe(2);
    expect((await getStored()).profiles.map((profile) => profile.id)).toEqual(['ok']);
  });

  it('normalises login urls to an origin on import', async () => {
    await importProfiles([login('1', 'https://a.example/login?next=/x')]);
    const s = await getStored();
    expect((s.profiles[0] as LoginProfile).url).toBe('https://a.example');
  });

  it('never lets a malformed row reach the popup renderer', async () => {
    await importProfiles([{ id: 'bad', kind: 'identity' }] as unknown[]);
    const s = await getStored();
    expect(() => s.profiles.forEach((p) => {
      if (p.kind === 'identity') Object.values(p.fields).join(' ');
    })).not.toThrow();
  });
});

describe('storage — content versions and fill recency', () => {
  it('lets an open editor save after filling and preserves the latest use time', async () => {
    const draft = { ...ident('editor'), updatedAt: 100 };
    await setStored({ version: 1, profiles: [draft], blacklist: [] });
    await touchProfile(draft.id);
    const used = (await getStored()).profiles[0]!;
    expect(used.updatedAt).toBe(100);
    expect(used.lastUsedAt).toBeGreaterThan(100);
    await upsertProfile({ ...draft, label: 'Edited label' }, { create: false, expectedUpdatedAt: 100 });
    expect((await getStored()).profiles[0]).toMatchObject({ label: 'Edited label', lastUsedAt: used.lastUsedAt });
  });

  it('advances content versions for same-millisecond edits and rejects the older editor', async () => {
    const now = Date.now();
    const draft = { ...ident('editor'), updatedAt: now };
    await setStored({ version: 1, profiles: [draft], blacklist: [] });
    await upsertProfile({ ...draft, label: 'First editor' }, { expectedUpdatedAt: now });
    expect((await getStored()).profiles[0]!.updatedAt).toBeGreaterThan(now);
    await expect(upsertProfile({ ...draft, label: 'Stale editor' }, { expectedUpdatedAt: now })).rejects.toThrow('其他页面更新');
  });

  it('invalidates an open editor when an import changes content with the same old timestamp', async () => {
    const draft = { ...ident('editor'), updatedAt: Date.now() };
    await setStored({ version: 1, profiles: [draft], blacklist: [] });
    await importProfiles([{ ...draft, label: 'Imported label' }]);
    await expect(upsertProfile({ ...draft, label: 'Stale editor' }, { expectedUpdatedAt: draft.updatedAt })).rejects.toThrow('其他页面更新');
  });

  it('keeps content versions and current recency when importing identical content', async () => {
    const draft = { ...ident('editor'), updatedAt: 100, lastUsedAt: 500 };
    await setStored({ version: 1, profiles: [draft], blacklist: [] });
    await importProfiles([{ ...draft, lastUsedAt: 200 }]);
    expect((await getStored()).profiles[0]).toEqual(draft);
  });

  it('reads legacy schema v1 records without adding a mandatory last-used field', async () => {
    const draft = ident('legacy');
    await setStored({ version: 1, profiles: [draft], blacklist: [] });
    expect(await getStored()).toEqual({ version: 1, profiles: [draft], blacklist: [] });
    expect(isProfile({ ...draft, lastUsedAt: 123 })).toBe(true);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '123', null])('rejects invalid optional last-used metadata %s', async lastUsedAt => {
    const draft = { ...ident('invalid'), lastUsedAt };
    expect(isProfile(draft)).toBe(false);
    expect(await importProfiles([draft])).toMatchObject({ imported: 0, rejected: 1 });
  });
});

describe('storage — legacy identity read compatibility', () => {
  it('preserves known legacy credential keys while unrelated records are read and touched', async () => {
    const legacy = { ...ident('legacy'), fields: { email: 'synthetic@example.test', username: 'synthetic-user', 'current-password': 'synthetic-old', 'new-password': 'synthetic-new' } };
    const original = { version: 1 as const, profiles: [login('usable'), legacy], blacklist: [] };
    await setStored(original);
    expect(await getStored()).toEqual(original);
    await touchProfile('usable');
    expect((await getStored()).profiles[1]).toEqual(legacy);
    expect(isProfile(legacy)).toBe(false);
    expect(await importProfiles([legacy])).toMatchObject({ imported: 0, rejected: 1 });
    await expect(upsertProfile(legacy)).rejects.toThrow('记录格式不正确');
  });

  it('still rejects unknown legacy field keys without replacing the original data', async () => {
    const original = { version: 1 as const, profiles: [{ ...ident('legacy'), fields: { 'unknown-token': 'synthetic-value' } }], blacklist: [] };
    await setStored(original as unknown as Stored);
    await expect(getStored()).rejects.toThrow('记录损坏');
    expect(h.store.get('qf.stored.v1')).toEqual(original);
  });
});

it.each(['edit', 'import'] as const)('invalidates old editors after %s when a legacy timestamp cannot be incremented', async action => {
  const draft = { ...ident('large-timestamp'), updatedAt: 1e100 };
  await setStored({ version: 1, profiles: [draft], blacklist: [] });
  const changed = { ...draft, label: 'Changed synthetic label' };
  if (action === 'edit') await upsertProfile(changed, { expectedUpdatedAt: draft.updatedAt });
  else await importProfiles([changed]);
  const stored = (await getStored()).profiles[0]!;
  expect(Number.isFinite(stored.updatedAt)).toBe(true);
  expect(stored.updatedAt).not.toBe(draft.updatedAt);
  await expect(upsertProfile(draft, { expectedUpdatedAt: draft.updatedAt })).rejects.toThrow('其他页面更新');
});
