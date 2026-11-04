import { beforeEach, expect, it, vi } from 'vitest';
import { installChromeMock, loginProfile, STORE_KEY, type Harness } from './helpers/chrome-mock';
import type { Stored } from '../src/lib/types';

const id = 'neilinbkkjgcnflgamepebchiapfcibm';
const page = { id, url: `chrome-extension://${id}/options.html` };
const content = { id, url: 'https://site.example/login', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
let listener: (msg: unknown, sender: chrome.runtime.MessageSender, reply: (response: any) => void) => void;
let h: Harness;
let accessLocal: ReturnType<typeof vi.fn>;
let accessSession: ReturnType<typeof vi.fn>;
let sendToTab: ReturnType<typeof vi.fn>;
const fixture: Stored = { version: 1, blacklist: ['https://other.example'], profiles: [
  loginProfile({ password: 'synthetic-login-secret' }),
  loginProfile({ id: 'other', url: 'https://other.example', username: 'synthetic-other-user', password: 'synthetic-other-secret' }),
  { id: 'identity', kind: 'identity', label: 'Synthetic home', fields: { email: 'synthetic-private@example.test', tel: 'synthetic-private-phone' }, updatedAt: 1 },
] };
const call = (msg: Record<string, unknown>, sender: chrome.runtime.MessageSender = page) =>
  new Promise<any>(reply => listener({ generation: '0', ...msg }, sender, reply));

beforeEach(async () => {
  vi.resetModules();
  h = installChromeMock({ [STORE_KEY]: fixture });
  accessLocal = vi.fn(async () => {});
  accessSession = vi.fn(async () => {});
  sendToTab = vi.fn(async () => {});
  Object.assign(chrome.storage.local, { setAccessLevel: accessLocal });
  Object.assign(chrome.storage.session, { setAccessLevel: accessSession });
  Object.assign(chrome.runtime, { id, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onInstalled: { addListener() {} } });
  Object.assign(chrome.tabs, { query: vi.fn(async () => [{ id: 7 }, { id: 8 }]), sendMessage: sendToTab });
  await import('../src/background/service-worker');
});

it('restricts both storage areas before returning any message response', async () => {
  expect(accessLocal).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  expect(accessSession).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  expect((await call({ type: 'qf.get_profiles' })).type).toBe('qf.profiles');
});

it.each(['local', 'session'] as const)('waits for %s isolation before data access while registering the listener immediately', async area => {
  vi.resetModules();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  Object.assign(chrome.storage[area], { setAccessLevel: vi.fn(() => ready) });
  const reads = vi.spyOn(chrome.storage.local, 'get');
  await import('../src/background/service-worker');
  let responded = false;
  const response = call({ type: 'qf.get_profiles' }).then(result => { responded = true; return result; });
  await Promise.resolve(); await Promise.resolve();
  expect(responded).toBe(false); expect(reads).not.toHaveBeenCalled();
  release();
  expect((await response).type).toBe('qf.profiles');
});

it('fails closed when a supported storage access-level setter rejects', async () => {
  vi.resetModules();
  Object.assign(chrome.storage.local, { setAccessLevel: vi.fn(async () => { throw Error('synthetic isolation failure'); }) });
  const reads = vi.spyOn(chrome.storage.local, 'get');
  await import('../src/background/service-worker');
  expect(await call({ type: 'qf.get_profiles' })).toMatchObject({ type: 'qf.error', message: 'synthetic isolation failure' });
  expect(reads).not.toHaveBeenCalled();
});

it.each(['qf.get_profiles', 'qf.export', 'qf.export_raw', 'qf.clear_all', 'qf.update_profile', 'qf.vault_status', 'qf.vault_export', 'qf.vault_lock'])('rejects page-only request %s from a genuine content sender', async type => {
  const before = structuredClone(h.store.get(STORE_KEY));
  expect((await call({ type }, content)).type).toBe('qf.error');
  expect(h.store.get(STORE_KEY)).toEqual(before);
});

it('returns summaries without login passwords, identity values, or other-origin records', async () => {
  const result = await call({ type: 'qf.content_profiles' }, content);
  expect(result.type).toBe('qf.profiles');
  expect(result.profiles).toEqual([
    expect.objectContaining({ id: 'L1', password: '', username: 'alice' }),
    expect.objectContaining({ id: 'identity', fields: { email: '', tel: '' } }),
  ]);
  expect(result.blacklist).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-login-secret|synthetic-other|synthetic-private|other\.example/);
});

it('returns one requested profile only after origin and generation validation', async () => {
  expect((await call({ type: 'qf.fill_profile', id: 'other' }, content)).type).toBe('qf.error');
  expect((await call({ type: 'qf.fill_profile', id: 'L1', generation: 'stale' }, content)).type).toBe('qf.error');
  expect((await call({ type: 'qf.fill_profile', id: 'missing' }, content)).type).toBe('qf.error');
  const result = await call({ type: 'qf.fill_profile', id: 'L1' }, content);
  expect(result).toMatchObject({ type: 'qf.profile', profile: { id: 'L1', password: 'synthetic-login-secret' }, generation: '0' });
  expect(result.profiles).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
  expect((h.store.get(STORE_KEY) as Stored).profiles[0]!.updatedAt).toBe(1);
  expect((h.store.get(STORE_KEY) as Stored).profiles[0]!.lastUsedAt).toBeGreaterThan(1);
});

it('returns the selected identity without also returning any login', async () => {
  const result = await call({ type: 'qf.fill_profile', id: 'identity' }, content);
  expect(result.profile).toMatchObject({ id: 'identity', fields: { email: 'synthetic-private@example.test' } });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-login-secret|synthetic-other-secret/);
});

it('rejects content requests from a forged runtime ID or subframe', async () => {
  for (const sender of [{ ...content, id: 'external' }, { ...content, frameId: 1 }, page])
    expect((await call({ type: 'qf.content_profiles' }, sender)).type).toBe('qf.error');
});

it('broadcasts metadata without stored values after a record changes', async () => {
  await call({ type: 'qf.update_profile', profile: {id:'identity',kind:'identity',label:'Updated synthetic label',fields:{email:'synthetic-new@example.test'},updatedAt:Date.now()} });
  await h.pump();
  await call({ type: 'qf.get_profiles' });
  expect(sendToTab).toHaveBeenCalled();
  for (const args of sendToTab.mock.calls) {
    expect(args[1]).toEqual({ type: 'qf.data_changed', generation: '0', locked: false });
    expect(args[2]).toEqual({ frameId: 0 });
    expect(JSON.stringify(args)).not.toMatch(/synthetic|password|profiles|fields/);
  }
});

it('redacts saved passwords from pending decisions and rechecks duplicate and blacklist on replay', async () => {
  await call({ type: 'qf.capture_begin', id: 'synthetic-operation' }, content);
  const result = await call({ type: 'qf.pending_put', id: 'synthetic-operation', candidate: { origin: 'https://site.example', username: 'alice', password: 'synthetic-submitted' } }, content);
  expect(result.existing).toMatchObject({ id: 'L1', password: '' });
  expect(JSON.stringify(result)).not.toContain('synthetic-login-secret');
  h.setStored({ ...fixture, blacklist: ['https://site.example'] });
  const replay = await call({ type: 'qf.pending_get' }, content);
  expect(replay).toMatchObject({ pending: null, reason: 'blacklisted' });
});

it('routes vault controls only through the management sender and blocks fill/capture after lock', async () => {
  const password = 'synthetic master password';
  expect(await call({ type: 'qf.vault_status' })).toMatchObject({ enabled:false, unlocked:true });
  const setup = await call({ type:'qf.vault_setup', password });
  expect(setup).toMatchObject({ type:'qf.vault_status', enabled:true, unlocked:true });
  expect(JSON.stringify(h.store.get(STORE_KEY))).not.toMatch(/synthetic-login-secret|synthetic-private/);
  const backup = await call({ type:'qf.vault_export' });
  expect(backup.envelope.format).toBe('qf-vault');
  const locked = await call({ type:'qf.vault_lock' });
  expect(locked).toMatchObject({ enabled:true, unlocked:false });
  expect((await call({ type:'qf.fill_profile',id:'L1',generation:locked.generation },content)).type).toBe('qf.error');
  expect((await call({ type:'qf.capture_begin',id:'synthetic-locked-operation' },content)).type).toBe('qf.error');
  expect((await call({ type:'qf.pending_put',id:'synthetic-locked-operation',candidate:{origin:'https://site.example',username:'alice',password:'synthetic-new-submitted'} },content)).type).toBe('qf.error');
  expect(h.store.get('qf.pending.v2')).toBeUndefined();
  expect(await call({ type:'qf.vault_unlock',password })).toMatchObject({ enabled:true,unlocked:true });
  expect((await call({ type:'qf.content_profiles' },content)).profiles[0].password).toBe('');
});

const diagnostics = { id, url: `chrome-extension://${id}/diagnostics.html`, frameId: 0 };
const popup = { id, url: `chrome-extension://${id}/popup.html` };

it.each(['qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile', 'qf.add_blacklist', 'qf.remove_blacklist', 'qf.clear_all', 'qf.export', 'qf.export_raw', 'qf.import', 'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_lock', 'qf.vault_change', 'qf.vault_export', 'qf.vault_restore'])('denies diagnostics management %s before reading data', async type => {
  const reads = vi.spyOn(chrome.storage.local, 'get');
  const before = structuredClone(h.store.get(STORE_KEY));
  expect(await call({ type }, diagnostics)).toMatchObject({ type: 'qf.error' });
  expect(reads).not.toHaveBeenCalled();
  expect(h.store.get(STORE_KEY)).toEqual(before);
});

it.each(['qf.clear_all', 'qf.export', 'qf.export_raw', 'qf.import', 'qf.vault_setup', 'qf.vault_lock', 'qf.vault_change', 'qf.vault_export', 'qf.vault_restore'])('denies popup excess capability %s before reading data', async type => {
  const reads = vi.spyOn(chrome.storage.local, 'get');
  expect(await call({ type }, popup)).toMatchObject({ type: 'qf.error' });
  expect(reads).not.toHaveBeenCalled();
});

it('preserves popup profile access and diagnostics dedicated trace permissions', async () => {
  expect((await call({ type: 'qf.get_profiles' }, popup)).type).toBe('qf.profiles');
  expect((await call({ type: 'qf.vault_status' }, popup)).type).toBe('qf.vault_status');
  // This harness stores scalar keys; emulate Chrome session multi-key reads for trace only.
  const get = chrome.storage.session.get.bind(chrome.storage.session);
  vi.spyOn(chrome.storage.session, 'get').mockImplementation((async (keys: string | string[]) =>
    Array.isArray(keys) ? Object.fromEntries(keys.map(key => [key, h.store.get(key)])) : get(keys)) as any);
  expect(await call({ type: 'qf.trace_set', enabled: true }, diagnostics)).toMatchObject({ type: 'qf.trace_result', enabled: true });
  expect(await call({ type: 'qf.trace_status' }, diagnostics)).toMatchObject({ enabled: true });
  expect(await call({ type: 'qf.trace_event', event: 'save_click', details: { operationId: 'synthetic-operation' } }, content)).toMatchObject({ enabled: true });
  expect(await call({ type: 'qf.trace_read' }, diagnostics)).toMatchObject({ events: [{ event: 'save_click', operationId: 'synthetic-operation', tabId: 7 }] });
  expect((await call({ type: 'qf.trace_event', event: 'banner_shown' }, diagnostics)).type).toBe('qf.error');
  expect((await call({ type: 'qf.trace_read' }, popup)).type).toBe('qf.error');
  expect((await call({ type: 'qf.trace_set', enabled: false }, { ...diagnostics, id: 'external' })).type).toBe('qf.error');
  expect((await call({ type: 'qf.trace_read' }, { ...diagnostics, frameId: 1 })).type).toBe('qf.error');
});

it.each(['qf.get_profiles', 'qf.export', 'qf.export_raw', 'qf.clear_all', 'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_export', 'qf.vault_restore'])('denies unlock frame management %s before reading data', async type => {
  const reads = vi.spyOn(chrome.storage.local, 'get');
  const sender = { id, url: `chrome-extension://${id}/unlock.html?nonce=synthetic-nonce`, frameId: 1, tab: { id: 7 } } as chrome.runtime.MessageSender;
  expect(await call({ type }, sender)).toMatchObject({ type: 'qf.error' });
  expect(reads).not.toHaveBeenCalled();
});

it.each([false, true])('fills near-full stored data with encryption=%s without persisting optional recency', async encrypted => {
  const setup = encrypted ? await call({ type: 'qf.vault_setup', password: 'Synthetic-Master-42!' }) : { generation: '0' };
  h.store.set('synthetic.large-setting', 'x'.repeat(9 * 1024 * 1024));
  Object.assign(chrome.storage.local, {
    QUOTA_BYTES: 10 * 1024 * 1024,
    getBytesInUse: async (keys: string[] | null) => [...h.store.entries()]
      .filter(([key]) => keys === null || keys.includes(key))
      .reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)), 0),
  });
  const before = structuredClone([...h.store.entries()]);
  const result = await call({ type: 'qf.fill_profile', id: 'L1', generation: setup.generation }, content);
  expect(result).toMatchObject({ type: 'qf.profile', profile: { id: 'L1', password: 'synthetic-login-secret' }, generation: setup.generation });
  expect([...h.store.entries()]).toEqual(before);
});

it('fills when recency persistence fails with an ordinary storage error', async () => {
  vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(Error('synthetic storage failure'));
  expect(await call({ type: 'qf.fill_profile', id: 'L1' }, content)).toMatchObject({
    type: 'qf.profile', profile: { id: 'L1', password: 'synthetic-login-secret' },
  });
});

it('fills when local records become corrupt during the recency read', async () => {
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  let primaryReads = 0;
  vi.spyOn(chrome.storage.local, 'get').mockImplementation((async (key: string) => {
    if (key === STORE_KEY && ++primaryReads === 2) h.store.set(STORE_KEY, { version: 99 });
    return get(key);
  }) as any);
  expect(await call({ type: 'qf.fill_profile', id: 'L1' }, content)).toMatchObject({
    type: 'qf.profile', profile: { id: 'L1', password: 'synthetic-login-secret' },
  });
});

it('still blocks fill when the encrypted vault locks before the record is read', async () => {
  const setup = await call({ type: 'qf.vault_setup', password: 'Synthetic-Master-42!' });
  await call({ type: 'qf.get_profiles' }); // Drain setup broadcasts before fault injection.
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  vi.spyOn(chrome.storage.local, 'get').mockImplementation((async (key: string) => {
    if (key === STORE_KEY) h.store.delete('qf.vault.unlock.v1');
    return get(key);
  }) as any);
  expect(await call({ type: 'qf.fill_profile', id: 'L1', generation: setup.generation }, content)).toMatchObject({
    type: 'qf.error', message: expect.stringContaining('锁定'),
  });
});

it.each(['expiry', 'unlock revocation', 'generation rotation'])('blocks fill after %s during the recency read', async fault => {
  const setup = await call({ type: 'qf.vault_setup', password: 'Synthetic-Master-42!' });
  await call({ type: 'qf.get_profiles' });
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  let primaryReads = 0;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(chrome.storage.local, 'get').mockImplementation((async (key: string) => {
    if (key === STORE_KEY && ++primaryReads === 2) {
      if (fault === 'expiry') {
        const expiresAt = (h.store.get('qf.vault.unlock.v1') as { expiresAt: number }).expiresAt;
        clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
      } else if (fault === 'unlock revocation') h.store.delete('qf.vault.unlock.v1');
      else h.store.set('qf.generation', 'synthetic-rotated-generation');
    }
    return get(key);
  }) as any);
  try {
    const result = await call({ type: 'qf.fill_profile', id: 'L1', generation: setup.generation }, content);
    expect(primaryReads).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ type: 'qf.error' });
    expect(JSON.stringify(result)).not.toContain('synthetic-login-secret');
  } finally { clock?.mockRestore(); }
});

it('blocks fill if the final authorization state cannot be read', async () => {
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  let primaryReads = 0;
  vi.spyOn(chrome.storage.local, 'get').mockImplementation((async (key: string) => {
    if (key === STORE_KEY && ++primaryReads >= 4) throw Error('synthetic authority read failure');
    return get(key);
  }) as any);
  expect(await call({ type: 'qf.fill_profile', id: 'L1' }, content)).toMatchObject({ type: 'qf.error' });
});

it('allows only the trusted top-level popup to unlock the existing vault',async()=>{
 const password='Synthetic8!';await call({type:'qf.vault_setup',password});await call({type:'qf.vault_lock'});
 expect(await call({type:'qf.vault_unlock',password},popup)).toMatchObject({type:'qf.vault_status',unlocked:true});
 expect(await call({type:'qf.vault_unlock',password},{...popup,frameId:1})).toMatchObject({type:'qf.error'});
});


it('saves an open identity editor after filling without a false conflict', async () => {
  const draft = (await call({ type: 'qf.get_profiles' })).profiles.find((p: { id: string }) => p.id === 'identity');
  expect((await call({ type: 'qf.fill_profile', id: draft.id }, content)).type).toBe('qf.profile');
  const result = await call({ type: 'qf.update_profile', profile: { ...draft, label: 'Edited after use' }, create: false, expectedUpdatedAt: draft.updatedAt });
  expect(result.type).toBe('qf.profiles');
  expect(result.profiles.find((p: { id: string }) => p.id === draft.id)).toMatchObject({ label: 'Edited after use', lastUsedAt: expect.any(Number) });
});

it('keeps a pending account update valid after the account is filled', async () => {
  const setup = await call({ type: 'qf.vault_setup', password: 'synthetic master password' });
  const generation = setup.generation;
  const operation = { id: 'synthetic-recency-operation', generation };
  expect((await call({ type: 'qf.capture_begin', ...operation }, content)).type).toBe('qf.ok');
  await call({ type: 'qf.pending_put', ...operation, candidate: { origin: 'https://site.example', username: 'alice', password: 'synthetic-updated-password' } }, content);
  expect((await call({ type: 'qf.fill_profile', id: 'L1', generation }, content)).type).toBe('qf.profile');
  expect(await call({ type: 'qf.pending_save', ...operation }, content)).toMatchObject({ type: 'qf.ok' });
  const updated = (await call({ type: 'qf.get_profiles', generation })).profiles.find((p: { id: string }) => p.id === 'L1');
  expect(updated).toMatchObject({ password: 'synthetic-updated-password', lastUsedAt: expect.any(Number) });
});
it('rejects a lease that expires during the final generation read', async()=>{
 const setup=await call({type:'qf.vault_setup',password:'Synthetic8!'});await h.pump();await call({type:'qf.vault_status'});
 const get=chrome.storage.local.get.bind(chrome.storage.local);let generationReads=0;const now=vi.spyOn(Date,'now');
 vi.spyOn(chrome.storage.local,'get').mockImplementation((async(key:string)=>{
  const value=await get(key);if(key==='qf.generation'&&++generationReads===2)now.mockReturnValue(setup.expiresAt+1);return value;
 }) as any);
 try{expect(await call({type:'qf.fill_profile',id:'L1',generation:setup.generation},content)).toMatchObject({type:'qf.error'});}finally{now.mockRestore();}
});
