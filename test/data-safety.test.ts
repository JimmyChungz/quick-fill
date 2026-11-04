import { beforeEach, describe, it, expect } from 'vitest';
import {
  installChromeMock,
  loginProfile,
  STORE_KEY,
} from './helpers/chrome-mock';
import {
  getStored,
  upsertProfile,
  clearAll,
  isProfile,
} from '../src/lib/storage';
import { send } from '../src/lib/messaging';
const PENDING_KEY = 'qf.pendingBanner';
let h: ReturnType<typeof installChromeMock>;
beforeEach(() => {
  h = installChromeMock();
});
describe('QF data safety boundaries', () => {
  it('preserves corrupt top-level bytes and refuses reads/writes instead of treating as empty', async () => {
    const raw = { version: 99, profiles: [loginProfile()], blacklist: [] };
    h.store.set(STORE_KEY, structuredClone(raw));
    await expect(getStored()).rejects.toThrow();
    await expect(upsertProfile(loginProfile({ id: 'new' }))).rejects.toThrow();
    expect(h.store.get(STORE_KEY)).toEqual(raw);
  });
  it('rejects nonfinite timestamps and invalid login URLs', () => {
    expect(isProfile({ ...loginProfile(), updatedAt: Infinity })).toBe(false);
    expect(isProfile({ ...loginProfile(), url: 'garbage' })).toBe(false);
  });
  it('clear removes legacy pending credentials too', async () => {
    h.store.set(PENDING_KEY, { password: 'fake-password' });
    await clearAll();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });
  it('rejects qf.error response rather than reporting message success', async () => {
    await expect(
      send({ type: 'qf.error', message: 'simulated' }),
    ).rejects.toThrow();
  });
});
it('drops empty identity values when creating records', async () => {
  await upsertProfile({
    id: 'I',
    kind: 'identity',
    label: 'demo',
    fields: { name: 'Demo', email: '' },
    updatedAt: 1,
  });
  expect((await getStored()).profiles[0]).toMatchObject({
    fields: { name: 'Demo' },
  });
  expect(Object.keys(((await getStored()).profiles[0] as any).fields)).toEqual([
    'name',
  ]);
});
