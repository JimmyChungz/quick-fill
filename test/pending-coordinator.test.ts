// Credential setup is exercised with the real vault in credential-policy.test.ts and browser suites.
vi.mock('../src/background/credential-policy', () => ({requireEncryptedCredentials: async () => {}}));
import { beforeEach, it, expect, vi } from 'vitest';
import { EXTENSION_ID, PAGE_SENDER } from './helpers/chrome-mock';
let alarmListener: any, tabListener: any;
let listener: any;
let local: Record<string, any>;
let session: Record<string, any>;
const sender = (tabId: number) => ({
  id: EXTENSION_ID,
  tab: { id: tabId },
  frameId: 0,
  documentId: `doc-${tabId}`,
  url: 'https://audit.example/login',
});
const sendDirect = (msg: any, tabId?: number) =>
  new Promise<any>((r) =>
    listener({ generation: '0', ...msg }, tabId !== undefined ? sender(tabId) : PAGE_SENDER, r),
  );
const call = async (msg: any, tabId?: number) => {
  if (msg.type === 'qf.pending_put')
    await sendDirect({ type: 'qf.capture_begin', id: msg.id }, tabId);
  return sendDirect(msg, tabId);
};
beforeEach(async () => {
  vi.resetModules();
  local = {};
  session = {};
  const area = (s: Record<string, any>) => ({
    get: async (k?: string) =>
      k ? { [k]: structuredClone(s[k]) } : structuredClone(s),
    set: async (o: any) => {
      Object.assign(s, structuredClone(o));
    },
    remove: async (k: string | string[]) => {
      for (const x of Array.isArray(k) ? k : [k]) delete s[x];
    },
    clear: async () => {
      for (const k of Object.keys(s)) delete s[k];
    },
  });
  (globalThis as any).chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener(fn: any) {
          listener = fn;
        },
      },
      onInstalled: { addListener() {} },
    },
    tabs: {
      onRemoved: {
        addListener(fn: any) {
          tabListener = fn;
        },
      },
    },
    alarms: {
      create() {},
      onAlarm: {
        addListener(fn: any) {
          alarmListener = fn;
        },
      },
    },
  };
  await import('../src/background/service-worker');
});
const candidate = {
  origin: 'https://audit.example',
  username: 'demo',
  password: 'fake-secret',
};
it('rejects a write created before clear, even if delivered after clear', async () => {
  const clear = await call({ type: 'qf.clear_all' });
  expect(clear.type).not.toBe('qf.error');
  const res = await call({
    type: 'qf.update_profile',
    profile: {
      id: 'old',
      kind: 'login',
      url: candidate.origin,
      username: 'demo',
      password: 'fake',
      updatedAt: 1,
    },
  });
  expect(res.type).toBe('qf.error');
  expect(local['qf.stored.v1'].profiles).toEqual([]);
});
it('isolates pending operations by tab and only drops the requested operation', async () => {
  const a = await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  const b = await call(
    {
      type: 'qf.pending_put',
      candidate: { ...candidate, username: 'B' },
      id: 'B',
    },
    2,
  );
  expect(a.pending?.id).toBe('A');
  expect(b.pending?.id).toBe('B');
  expect((await call({ type: 'qf.pending_get' }, 1)).pending?.id).toBe('A');
  await call({ type: 'qf.pending_drop', id: 'A' }, 1);
  expect((await call({ type: 'qf.pending_get' }, 2)).pending?.id).toBe('B');
});
it('keeps a pending operation when profile storage fails, then permits retry', async () => {
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  const original = chrome.storage.local.set;
  (chrome.storage.local as any).set = async () => {
    throw Error('quota');
  };
  expect((await call({ type: 'qf.pending_save', id: 'A' }, 1)).type).toBe(
    'qf.error',
  );
  expect((await call({ type: 'qf.pending_get' }, 1)).pending?.id).toBe('A');
  chrome.storage.local.set = original;
  expect((await call({ type: 'qf.pending_save', id: 'A' }, 1)).type).not.toBe(
    'qf.error',
  );
  expect(local['qf.stored.v1'].profiles).toHaveLength(1);
  expect((await call({ type: 'qf.pending_get' }, 1)).pending).toBeNull();
});
it('rejects pending access from another origin or subframe', async () => {
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  const res = await new Promise<any>((r) =>
    listener(
      { type: 'qf.pending_save', id: 'A', generation: '0' },
      { ...sender(1), url: 'https://evil.example' },
      r,
    ),
  );
  expect(res.type).toBe('qf.error');
});
it('does not guess an account update when username is absent', async () => {
  local['qf.stored.v1'] = {
    version: 1,
    blacklist: [],
    profiles: [
      {
        id: 'old',
        kind: 'login',
        url: candidate.origin,
        username: 'alice',
        password: 'old',
        updatedAt: 1,
      },
    ],
  };
  await call(
    {
      type: 'qf.pending_put',
      candidate: { ...candidate, username: '' },
      id: 'A',
    },
    1,
  );
  await call({ type: 'qf.pending_save', id: 'A' }, 1);
  expect(local['qf.stored.v1'].profiles[0].password).toBe('old');
  expect(local['qf.stored.v1'].profiles).toHaveLength(2);
});
it('acknowledges a repeated save without duplicating a committed profile', async () => {
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  expect((await call({ type: 'qf.pending_save', id: 'A' }, 1)).type).not.toBe(
    'qf.error',
  );
  expect((await call({ type: 'qf.pending_save', id: 'A' }, 1)).type).not.toBe(
    'qf.error',
  );
  expect(local['qf.stored.v1'].profiles).toHaveLength(1);
});
it('does not overwrite a profile changed after the capture decision', async () => {
  local['qf.stored.v1'] = {
    version: 1,
    blacklist: [],
    profiles: [
      {
        id: 'old',
        kind: 'login',
        url: candidate.origin,
        username: 'demo',
        password: 'first',
        updatedAt: 1,
      },
    ],
  };
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  local['qf.stored.v1'].profiles[0].password = 'changed-elsewhere';
  local['qf.stored.v1'].profiles[0].updatedAt = 2;
  expect((await call({ type: 'qf.pending_save', id: 'A' }, 1)).type).toBe(
    'qf.error',
  );
  expect(local['qf.stored.v1'].profiles[0].password).toBe('changed-elsewhere');
});
it('keeps a raw recovery export available for unknown schema without changing it', async () => {
  const raw = {
    version: 99,
    profiles: [{ id: 'recoverable', password: 'fake-secret' }],
  };
  local['qf.stored.v1'] = structuredClone(raw);
  expect((await call({ type: 'qf.get_profiles' })).type).toBe('qf.error');
  expect((await call({ type: 'qf.export_raw' })).raw).toEqual(raw);
  expect(local['qf.stored.v1']).toEqual(raw);
});
it('rejects a focus permit that existed before clear even with current generation', async () => {
  await call({ type: 'qf.capture_begin', id: 'A' }, 1);
  const cleared = await call({ type: 'qf.clear_all' });
  const res = await sendDirect(
    {
      type: 'qf.pending_put',
      candidate,
      id: 'A',
      generation: cleared.generation,
    },
    1,
  );
  expect(res.type).toBe('qf.error');
  expect(Object.keys(session)).toHaveLength(0);
});

it('restores an unacknowledged candidate after a worker module restart', async () => {
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  vi.resetModules();
  await import('../src/background/service-worker');
  expect((await call({ type: 'qf.pending_get' }, 1)).pending?.id).toBe('A');
});
it('alarm cleanup expires credentials and closing a tab removes only its candidates', async () => {
  await call({ type: 'qf.pending_put', candidate, id: 'A' }, 1);
  session['qf.pending.v2'].A.createdAt = Date.now() - 6 * 60 * 1000;
  alarmListener({ name: 'qf.pending:A' });
  await call({ type: 'qf.get_profiles' });
  expect(session['qf.pending.v2']).toBeUndefined();
  await call({ type: 'qf.pending_put', candidate, id: 'B' }, 2);
  await call({ type: 'qf.pending_put', candidate, id: 'C' }, 3);
  tabListener(2);
  await call({ type: 'qf.get_profiles' });
  expect((await call({ type: 'qf.pending_get' }, 2)).pending).toBeNull();
  expect((await call({ type: 'qf.pending_get' }, 3)).pending?.id).toBe('C');
});

it.each([false, true])('rejects a stale second-tab save after Never Save, including existing-account=%s', async existingAccount => {
  local['qf.stored.v1'] = {
    version: 1, blacklist: [],
    profiles: existingAccount ? [{ id: 'saved-account', kind: 'login', url: candidate.origin, username: candidate.username, password: 'synthetic-original-password', updatedAt: 1 }] : [],
  };
  await call({ type: 'qf.pending_put', candidate: { ...candidate, username: 'synthetic-tab-a' }, id: 'A' }, 1);
  await call({ type: 'qf.pending_put', candidate, id: 'B' }, 2);
  const pendingB = structuredClone(session['qf.pending.v2'].B);
  expect(await call({ type: 'qf.pending_blacklist', id: 'A' }, 1)).toMatchObject({ type: 'qf.ok' });
  const persisted = structuredClone(local);
  const response = await call({ type: 'qf.pending_save', id: 'B' }, 2);
  expect(response).toMatchObject({ type: 'qf.error', message: expect.stringContaining('永不保存') });
  expect(local).toEqual(persisted);
  // A rejected action retains its candidate. The normal replay check then
  // drops it because the current origin is blacklisted.
  expect(session['qf.pending.v2'].B).toEqual(pendingB);
  expect(session['qf.pending.v2'].A).toBeUndefined();
  expect(session['qf.receipts'].B).toBeUndefined();
  expect(await call({ type: 'qf.pending_get' }, 2)).toMatchObject({ pending: null, reason: 'blacklisted' });
});
