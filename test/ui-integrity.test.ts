import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import type { Profile } from '../src/lib/types';

const login: Profile = { id: 'login', kind: 'login', url: 'https://example.com', username: 'alice', password: 'secret', updatedAt: 10 };
const identity: Profile = { id: 'identity', kind: 'identity', label: 'Home', fields: { name: 'Alice', email: 'a@example.com', 'address-line2': 'Floor 2', 'given-name': 'Alice' }, updatedAt: 20 };
let profiles: Profile[];
let blacklist: string[];
let sent: any[];
let failure: string | undefined;
let serverGeneration: string;
let commitThenLoseAck: boolean;
let rawStored: unknown;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const click = async (selector: string) => { el(selector).click(); await flush(); };
const value = (selector: string, next: string) => { el<HTMLInputElement>(selector).value = next; };

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, '', '/popup.html');
  window.onbeforeunload = null;
  profiles = structuredClone([login, identity]);
  blacklist = ['https://blocked.example'];
  sent = [];
  failure = undefined;
  serverGeneration = '0';
  commitThenLoseAck = false;
  rawStored = { version: 99, broken: 'original stored data' };
  vi.stubGlobal('Blob', NodeBlob);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:raw-backup') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('prompt', vi.fn(() => null));
  vi.stubGlobal('chrome', {
    tabs: { create: vi.fn(async () => ({})) },
    runtime: {
      sendMessage(message: any, callback: (response: unknown) => void) {
        sent.push(message);
        if (message.type === 'qf.vault_status') { queueMicrotask(() => callback({type:'qf.vault_status',enabled:false,unlocked:true,expiresAt:null})); return; }
        let response: unknown;
        if (commitThenLoseAck && message.type === 'qf.update_profile') {
          commitThenLoseAck = false;
          profiles.push(structuredClone(message.profile));
          response = { type: 'qf.error', message: 'Committed, acknowledgement lost' };
        }
        else if (failure) { response = { type: 'qf.error', message: failure }; failure = undefined; }
        else if (message.type === 'qf.export_raw') response = { type: 'qf.raw', raw: rawStored, generation: serverGeneration };
        else if (message.type === 'qf.get_profiles') response = { type: 'qf.profiles', profiles, blacklist, generation: serverGeneration };
        else {
          if (message.type === 'qf.update_profile') {
            const index = profiles.findIndex(profile => profile.id === message.profile.id);
            if (index >= 0) profiles[index] = structuredClone(message.profile);
            else profiles.push(structuredClone(message.profile));
          }
          if (message.type === 'qf.remove_blacklist') blacklist = blacklist.filter(origin => origin !== message.origin);
          response = { type: 'qf.profiles', profiles, blacklist, generation: serverGeneration, imported: 2, rejected: 1 };
        }
        queueMicrotask(() => callback(response));
      },
      openOptionsPage: vi.fn(),
      getURL: (path: string) => `chrome-extension://synthetic-id/${path}`,
    },
  });
});

afterEach(() => { window.onbeforeunload = null; window.history.replaceState({}, '', '/'); });

async function mount(surface: 'popup' | 'options', query = '') {
  window.history.replaceState({}, '', `/${surface}.html${query}`);
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/public/${surface}.html`, 'utf8');
  if (surface === 'popup') await import('../src/popup/popup');
  else await import('../src/options/options');
  await flush();
}

async function importFile(file: { size: number; text: () => Promise<string> }) {
  Object.defineProperty(el('#import-file'), 'files', { configurable: true, value: [file] });
  el('#import-file').dispatchEvent(new Event('change'));
  await flush();
}

describe('popup data integrity', () => {
  it('patches editable identity tokens, including explicit empty deletions, without resending hidden fields', async () => {
    await mount('popup', '?editor=identity&id=identity');
    value('#ni-name', 'New Name');
    value('#ni-email', '');
    await click('#ni-save');
    const update = sent.find(message => message.type === 'qf.update_profile');
    expect(update).toMatchObject({ patch: true, create: false, expectedUpdatedAt: 20, profile: { id: 'identity', fields: { name: 'New Name', email: '', tel: '' } } });
    expect(update.profile.fields).not.toHaveProperty('address-line2');
    expect(update.profile.fields).not.toHaveProperty('given-name');
  });

  it('keeps the identity editor and typed values on save failure', async () => {
    await mount('popup', '?editor=identity&id=identity');
    value('#ni-name', 'Unsaved Name');
    failure = 'Disk full';
    await click('#ni-save');
    expect(el('#new-identity-form').hidden).toBe(false);
    expect(el<HTMLInputElement>('#ni-name').value).toBe('Unsaved Name');
    expect(el('[role="alert"]').textContent).toContain('Disk full');
  });

  it('cancels popup login edits without writes and remasks after reveal', async () => {
    await mount('popup', '?editor=login&id=login');
    await click('#nl-reveal');
    expect(el<HTMLInputElement>('#nl-password').type).toBe('text');
    value('#nl-password', 'unsaved password');
    await click('#nl-cancel');
    expect(sent.filter(message => message.type === 'qf.update_profile')).toEqual([]);
    expect(el<HTMLInputElement>('#nl-password').value).toBe('');
    vi.resetModules();
    await mount('popup', '?editor=login&id=login');
    expect(el<HTMLInputElement>('#nl-password').type).toBe('password');
    expect(el('#nl-reveal').getAttribute('aria-pressed')).toBe('false');
  });

  it('pins the opening generation of a new draft across list refreshes', async () => {
    await mount('popup', '?editor=login');
    value('#nl-origin', 'https://example.com');
    value('#nl-password', 'draft');
    serverGeneration = 'after-clear';
    await click('#retry');
    await click('#nl-save');
    expect(sent.find(message => message.type === 'qf.update_profile')).toMatchObject({ generation: '0', create: true });
  });

  it.each(['login', 'identity'] as const)('reuses a new %s draft id after a committed write loses its acknowledgement', async kind => {
    await mount('popup', `?editor=${kind}`);
    const prefix = kind === 'login' ? 'nl' : 'ni';
    const openingId = el(`#${prefix}-save`).dataset.draftId;
    if (kind === 'login') value('#nl-origin', 'https://draft.example');
    else value('#ni-label', 'New identity');
    commitThenLoseAck = true;
    await click(`#${prefix}-save`);
    expect(el('[role="alert"]').textContent).toContain('acknowledgement lost');
    expect(el(`#${prefix}-save`).dataset.draftId).toBe(openingId);
    await click(`#${prefix}-save`);
    const updates = sent.filter(message => message.type === 'qf.update_profile');
    expect(updates[1].profile.id).toBe(updates[0].profile.id);
    expect(updates[0].profile.id).toBe(openingId);
    expect(profiles.filter(profile => profile.id === openingId)).toHaveLength(1);
    expect(el(`#${prefix}-save`).dataset.draftId).toBeUndefined();
    vi.resetModules();
    await mount('popup', `?editor=${kind}`);
    const nextId = el(`#${prefix}-save`).dataset.draftId;
    expect(nextId).not.toBe(openingId);
    await click(`#${prefix}-cancel`);
    expect(el(`#${prefix}-save`).dataset.draftId).toBeUndefined();
  });

  it('reports failed reads visibly', async () => {
    failure = 'Unreadable storage';
    await mount('popup');
    expect(el('[role="alert"]').textContent).toContain('Unreadable storage');
  });
});

describe('options management integrity', () => {
  it('downloads confirmed raw backup after normal reads fail, preserving unsupported schema data', async () => {
    failure = 'Unsupported stored schema';
    await mount('options');
    expect(el('[role="alert"]').textContent).toContain('Unsupported stored schema');
    await click('#export-raw');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('明文密码'));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'qf.export_raw' }));
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as unknown as NodeBlob;
    expect(JSON.parse(await blob.text())).toEqual(rawStored);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it('does not read or download raw storage when warning is cancelled', async () => {
    await mount('options');
    vi.mocked(confirm).mockReturnValue(false);
    await click('#export-raw');
    expect(sent.some(message => message.type === 'qf.export_raw')).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows raw backup errors without creating a download', async () => {
    await mount('options');
    failure = 'Raw read failed';
    await click('#export-raw');
    expect(el('[role="alert"]').textContent).toContain('Raw read failed');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('uses a masked login editor and cancels without writing credentials', async () => {
    await mount('options');
    await click('#logins-tbody [data-act="edit"]');
    expect(prompt).not.toHaveBeenCalled();
    expect(el<HTMLInputElement>('#edit-login-password').type).toBe('password');
    value('#edit-login-username', 'changed');
    await click('#edit-login-cancel');
    expect(sent.filter(message => message.type === 'qf.update_profile')).toEqual([]);
    expect(el<HTMLInputElement>('#edit-login-password').value).toBe('');
  });

  it('keeps edits on save failure and sends the edit revision when retried', async () => {
    await mount('options');
    await click('#logins-tbody [data-act="edit"]');
    value('#edit-login-username', 'changed');
    failure = 'Save rejected';
    await click('#edit-login-save');
    expect(el('#login-editor').hidden).toBe(false);
    expect(el<HTMLInputElement>('#edit-login-username').value).toBe('changed');
    expect(el('[role="alert"]').textContent).toContain('Save rejected');
    await click('#edit-login-save');
    expect(sent.filter(message => message.type === 'qf.update_profile').at(-1)).toMatchObject({ create: false, expectedUpdatedAt: 10 });
    expect(el<HTMLInputElement>('#edit-login-password').value).toBe('');
  });

  it('retains identity JSON after validation failure and cancels without writes', async () => {
    await mount('options');
    await click('#identities-tbody [data-act="edit"]');
    value('#edit-identity-fields', '[]');
    await click('#edit-identity-save');
    expect(el('[role="alert"]').textContent).toContain('JSON 对象');
    expect(el<HTMLTextAreaElement>('#edit-identity-fields').value).toBe('[]');
    await click('#edit-identity-cancel');
    expect(sent.filter(message => message.type === 'qf.update_profile')).toEqual([]);
  });

  it('saves all identity JSON tokens and deletes removed fields explicitly', async () => {
    await mount('options');
    await click('#identities-tbody [data-act="edit"]');
    value('#edit-identity-fields', JSON.stringify({ 'address-line2': 'Floor 3', 'given-name': 'New' }));
    await click('#edit-identity-save');
    expect(sent.find(message => message.type === 'qf.update_profile')).toMatchObject({
      patch: true, create: false, expectedUpdatedAt: 20,
      profile: { fields: { 'address-line2': 'Floor 3', 'given-name': 'New', name: '', email: '' } },
    });
  });

  it('pins an existing editor generation across list refreshes', async () => {
    await mount('options');
    await click('#logins-tbody [data-act="edit"]');
    serverGeneration = 'after-clear';
    await click('#retry');
    await click('#edit-login-save');
    expect(sent.find(message => message.type === 'qf.update_profile')).toMatchObject({ generation: '0', create: false });
  });

  it('shows blacklist origins and removes them through the service worker', async () => {
    await mount('options');
    expect(el('#blacklist').textContent).toContain('https://blocked.example');
    await click('#blacklist button');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'qf.remove_blacklist', origin: 'https://blocked.example' }));
    expect(el('#blacklist').textContent).toContain('暂无');
  });

  it('retains blacklist entry when removal fails', async () => {
    await mount('options');
    failure = 'Blacklist removal failed';
    await click('#blacklist button');
    expect(el('[role="alert"]').textContent).toContain('Blacklist removal failed');
    expect(el('#blacklist').textContent).toContain('https://blocked.example');
  });

  it('reports delete failure and retains the record', async () => {
    await mount('options');
    failure = 'Delete rejected';
    await click('#logins-tbody [data-act="del"]');
    expect(el('[role="alert"]').textContent).toContain('Delete rejected');
    expect(el('#logins-tbody').textContent).toContain('alice');
  });

  it('previews added, overwritten and invalid import rows before confirmation', async () => {
    await mount('options');
    const payload = { version: 1, profiles: [login, { ...login, id: 'new' }, { id: 'bad' }] };
    vi.mocked(confirm).mockReturnValue(false);
    await importFile({ size: 200, text: async () => JSON.stringify(payload) });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/新增 1.*覆盖 1.*跳过 1/s));
    expect(sent.filter(message => message.type === 'qf.import')).toEqual([]);
  });

  it('rejects oversized imports before reading the file', async () => {
    await mount('options');
    const text = vi.fn(async () => '{}');
    await importFile({ size: 10 * 1024 * 1024 + 1, text });
    expect(text).not.toHaveBeenCalled();
    expect(el('[role="alert"]').textContent).toContain('10 MB');
  });

  it('deduplicates import preview by id and reports failed import without a success notice', async () => {
    await mount('options');
    const payload = { version: 1, profiles: [login, { ...login, id: 'new' }, { ...login, id: 'new' }] };
    vi.mocked(confirm).mockImplementationOnce(() => { failure = 'Import failed'; return true; });
    await importFile({ size: 200, text: async () => JSON.stringify(payload) });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/新增 1.*覆盖 1.*跳过 0/s));
    expect(el('[role="alert"]').textContent).toContain('Import failed');
    expect(el('#notice').textContent).toBe('');
    expect(el('#logins-tbody').textContent).toContain('alice');
  });

  it('reports import read errors and clears through the service worker', async () => {
    await mount('options');
    await importFile({ size: 1, text: async () => { throw new Error('Cannot read file'); } });
    expect(el('[role="alert"]').textContent).toContain('Cannot read file');
    await click('#clear');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'qf.clear_all' }));
  });
});
