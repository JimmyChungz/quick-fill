import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Profile } from '../src/lib/types';

const login: Profile = { id: 'login & one', kind: 'login', url: 'https://example.com', username: 'alice', password: 'synthetic-password', updatedAt: 10 };
let profiles: Profile[];
let sent: any[];
let failure: string | undefined;
let locked: boolean;
let unlockFailure: boolean;
let deferredSave: ((response: unknown) => void) | undefined;
let deferSave: boolean;
let deferRead: boolean;
let deferredRead: ((response: unknown) => void) | undefined;
let storageChanged: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const click = async (selector: string) => { el(selector).click(); await flush(); };
const value = (selector: string, text: string) => { el<HTMLInputElement>(selector).value = text; el(selector).dispatchEvent(new Event('input', { bubbles: true })); };
const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, '', '/popup.html');
  window.onbeforeunload = null;
  profiles = structuredClone([login]);
  sent = [];
  failure = undefined;
  locked = false;
  unlockFailure = false;
  deferredSave = undefined;
  deferSave = false;
  deferRead = false;
  deferredRead = undefined;
  storageChanged = () => {};
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.spyOn(window, 'close').mockImplementation(() => {});
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: (listener: typeof storageChanged) => { storageChanged = listener; } } },
    tabs: { create: vi.fn(async () => ({})) },
    runtime: {
      getURL: (path: string) => `chrome-extension://synthetic-id/${path}`,
      openOptionsPage: vi.fn(async () => {}),
      sendMessage(message: any, callback: (response: unknown) => void) {
        sent.push(message);
        if (message.type === 'qf.vault_status') { queueMicrotask(() => callback({type:'qf.vault_status',enabled:locked,unlocked:!locked,generation:'generation-one'})); return; }
        if (message.type === 'qf.vault_unlock') { if (!unlockFailure) locked=false; queueMicrotask(() => callback(unlockFailure ? {type:'qf.error',message:'主密码不正确'} : {type:'qf.vault_status',enabled:true,unlocked:true,generation:'generation-one'})); return; }

        if (deferRead && message.type === 'qf.get_profiles') { deferredRead = callback; return; }
        if (deferSave && message.type === 'qf.update_profile') { deferredSave = callback; return; }
        const response = failure ? { type: 'qf.error', message: failure }
          : { type: 'qf.profiles', profiles, blacklist: [], generation: 'generation-one' };
        failure = undefined;
        queueMicrotask(() => callback(response));
      },
    },
  });
});
afterEach(() => { window.onbeforeunload = null; window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); });
async function mount(query = '') {
  window.history.replaceState({}, '', `/popup.html${query}`);
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/public/popup.html`, 'utf8');
  await import('../src/popup/popup');
  await flush();
}

describe('persistent editor entry and draft protection', () => {
  it('opens new editors in extension tabs while keeping ordinary popup forms hidden', async () => {
    await mount();
    await click('#new-login');
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'chrome-extension://synthetic-id/popup.html?editor=login' });
    await click('#new-identity');
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'chrome-extension://synthetic-id/popup.html?editor=identity' });
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el('#new-identity-form').hidden).toBe(true);
    expect(unload()).toBe(false);
  });

  it('passes only kind and encoded record id when opening an existing login', async () => {
    await mount();
    await click('#logins .item');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://synthetic-id/popup.html?editor=login&id=login%20%26%20one' });
    expect(el<HTMLInputElement>('#nl-password').value).toBe('');
  });

  it('boots an existing editor by id with its opening generation and masked password', async () => {
    await mount('?editor=login&id=login%20%26%20one');
    expect(el('#new-login-form').hidden).toBe(false);
    expect(el<HTMLInputElement>('#nl-password').type).toBe('password');
    expect(el<HTMLInputElement>('#nl-password').value).toBe('synthetic-password');
    expect(el('#nl-save').dataset.generation).toBe('generation-one');
    expect(el('#search').closest('header')!.hidden).toBe(true);
    expect(unload()).toBe(false);
  });

  it.each(['?editor=bogus', '?editor=login&id=missing', '?editor=identity&id=login%20%26%20one'])('does not create or save a draft for an invalid or missing editor target (%s)', async query => {
    await mount(query);
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el('#new-identity-form').hidden).toBe(true);
    expect(sent.some(message => message.type === 'qf.update_profile')).toBe(false);
    if (query !== '?editor=bogus') expect(el('#error').hidden).toBe(false);
  });

  it('preserves a dirty draft on blur and warns before navigation; reverting removes the warning', async () => {
    await mount('?editor=identity');
    expect(unload()).toBe(false);
    value('#ni-label', 'Draft identity');
    window.dispatchEvent(new Event('blur'));
    expect(el<HTMLInputElement>('#ni-label').value).toBe('Draft identity');
    expect(unload()).toBe(true);
    value('#ni-label', '');
    expect(unload()).toBe(false);
  });

  it('keeps edited values when cancellation is declined and clears/remasks only after confirmation', async () => {
    await mount('?editor=login&id=login%20%26%20one');
    await click('#nl-reveal');
    value('#nl-password', 'changed synthetic password');
    vi.mocked(confirm).mockReturnValue(false);
    await click('#nl-cancel');
    expect(el('#new-login-form').hidden).toBe(false);
    expect(unload()).toBe(true);
    vi.mocked(confirm).mockReturnValue(true);
    await click('#nl-cancel');
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el<HTMLInputElement>('#nl-password').value).toBe('');
    expect(el<HTMLInputElement>('#nl-password').type).toBe('password');
    expect(unload()).toBe(false);
    expect(window.close).not.toHaveBeenCalled();
  });

  it('keeps the same dirty draft after a failed save and ends the session only after acknowledged success', async () => {
    await mount('?editor=login');
    value('#nl-origin', 'https://draft.example');
    value('#nl-password', 'synthetic draft');
    const openingId = el('#nl-save').dataset.draftId;
    failure = 'Write failed';
    await click('#nl-save');
    expect(el('#error').textContent).toContain('Write failed');
    expect(el<HTMLInputElement>('#nl-password').value).toBe('synthetic draft');
    expect(el('#nl-save').dataset.draftId).toBe(openingId);
    expect(unload()).toBe(true);
    await click('#nl-save');
    expect(sent.filter(message => message.type === 'qf.update_profile').map(message => message.profile.id)).toEqual([openingId, openingId]);
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el<HTMLInputElement>('#nl-password').value).toBe('');
    expect(el('#editor-status').textContent).toContain('已保存');
    expect(unload()).toBe(false);
    expect(window.close).not.toHaveBeenCalled();
    await click('#editor-close');
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('prevents edits or cancellation racing an in-flight save and restores controls after rejection', async () => {
    await mount('?editor=identity');
    value('#ni-label', 'Synthetic identity');
    deferSave = true;
    await click('#ni-save');
    expect(el<HTMLInputElement>('#ni-label').disabled).toBe(true);
    expect(el<HTMLButtonElement>('#ni-cancel').disabled).toBe(true);
    expect(el<HTMLButtonElement>('#ni-save').disabled).toBe(true);
    deferredSave!({ type: 'qf.error', message: 'Write rejected' });
    await flush();
    expect(el<HTMLInputElement>('#ni-label').disabled).toBe(false);
    expect(el<HTMLButtonElement>('#ni-cancel').disabled).toBe(false);
    expect(el<HTMLInputElement>('#ni-label').value).toBe('Synthetic identity');
    expect(unload()).toBe(true);
  });

  it.each(['login', 'identity'] as const)('clears %s values, identifiers, and dirty protection when the local vault generation changes', async kind => {
    await mount(kind === 'login' ? '?editor=login&id=login%20%26%20one' : '?editor=identity');
    if (kind === 'login') { await click('#nl-reveal'); value('#nl-password', 'synthetic unsaved'); }
    else { value('#ni-label', 'Private identity'); value('#ni-email', 'synthetic@example.com'); }
    expect(unload()).toBe(true);
    storageChanged({ 'qf.generation': { oldValue: 'generation-one', newValue: 'generation-two' } }, 'local');
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('.form-panel input'), input => input.value).every(text => text === '')).toBe(true);
    expect(el<HTMLInputElement>('#nl-password').type).toBe('password');
    expect(el('#nl-reveal').getAttribute('aria-pressed')).toBe('false');
    for (const selector of ['#nl-save', '#ni-save']) {
      expect(el(selector).dataset.editId).toBeUndefined();
      expect(el(selector).dataset.draftId).toBeUndefined();
      expect(el(selector).dataset.updatedAt).toBeUndefined();
    }
    expect(el(`#new-${kind}-form`).hidden).toBe(true);
    expect(el('#editor-status').textContent).toContain('密码库状态已变更，请解锁后刷新；未保存草稿已清除');
    expect(unload()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('preserves dirty drafts for ordinary record updates and non-local generation notifications', async () => {
    await mount('?editor=identity');
    value('#ni-label', 'Keep draft');
    const id = el('#ni-save').dataset.draftId;
    storageChanged({ 'qf.stored.v1': { newValue: {} } }, 'local');
    storageChanged({ 'qf.generation': { newValue: 'session-change' } }, 'session');
    expect(el<HTMLInputElement>('#ni-label').value).toBe('Keep draft');
    expect(el('#ni-save').dataset.draftId).toBe(id);
    expect(unload()).toBe(true);
  });

  it('clears rendered popup records when the local vault generation changes', async () => {
    await mount();
    expect(el('#logins').textContent).toContain('alice');
    storageChanged({ 'qf.generation': { oldValue: 'generation-one', newValue: 'locked' } }, 'local');
    expect(el('#logins').childElementCount).toBe(0);
    expect(el('#identities').childElementCount).toBe(0);
  });

  it.each(['', '?editor=login&id=login%20%26%20one'])('ignores credential reads started before a vault generation reset (%s)', async query => {
    deferRead = true;
    await mount(query);
    storageChanged({ 'qf.generation': { oldValue: 'generation-one', newValue: 'locked' } }, 'local');
    deferredRead!({ type: 'qf.profiles', profiles, generation: 'generation-one' });
    await flush();
    expect(el('#logins').childElementCount).toBe(0);
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el<HTMLInputElement>('#nl-password').value).toBe('');
    expect(unload()).toBe(false);
  });

  it('does not replace the security reset message with a delayed save acknowledgement', async () => {
    await mount('?editor=identity');
    value('#ni-label', 'Synthetic identity');
    deferSave = true;
    await click('#ni-save');
    storageChanged({ 'qf.generation': { oldValue: 'generation-one', newValue: 'locked' } }, 'local');
    deferredSave!({ type: 'qf.profiles', profiles, generation: 'generation-one' });
    await flush();
    expect(el('#editor-status').textContent).toContain('未保存草稿已清除');
    expect(el('#new-identity-form').hidden).toBe(true);
    expect(unload()).toBe(false);
  });

  it('retries initial editor reads without opening an empty replacement record', async () => {
    failure = 'Locked or unreadable';
    await mount('?editor=login&id=login%20%26%20one');
    expect(el('#new-login-form').hidden).toBe(true);
    expect(el('#error').textContent).toContain('Locked or unreadable');
    await click('#retry');
    expect(el<HTMLInputElement>('#nl-password').value).toBe('synthetic-password');
    expect(el('#nl-save').dataset.editId).toBe('login & one');
  });
});

describe('toolbar popup direct master-password unlock', () => {
  it('offers direct unlock without reading records or opening management while locked', async () => {
    locked = true; await mount();
    expect(el('#vault-unlock-panel').hidden).toBe(false);
    expect(el('#record-list').hidden).toBe(true);
    expect(sent.some(message => message.type === 'qf.get_profiles')).toBe(false);
    expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
    value('#popup-master-password', 'Synthetic8!');
    el('#vault-unlock-form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); await flush();
    expect(sent.find(message => message.type === 'qf.vault_unlock')?.password).toBe('Synthetic8!');
    expect(el<HTMLInputElement>('#popup-master-password').value).toBe('');
    expect(el('#vault-unlock-panel').hidden).toBe(true);
    expect(el('#logins').textContent).toContain('alice');
    expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
  });
  it('keeps unlock available and clears the input after an incorrect password', async () => {
    locked=true; unlockFailure=true; await mount();value('#popup-master-password','Wrong-pass');
    el('#vault-unlock-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
    expect(el('#vault-unlock-panel').hidden).toBe(false);
    expect(el<HTMLInputElement>('#popup-master-password').value).toBe('');
    expect(el('#error').textContent).toContain('主密码不正确');
    expect(sent.some(message => message.type === 'qf.get_profiles')).toBe(false);
    expect(el<HTMLButtonElement>('#popup-unlock').disabled).toBe(false);
  });
});

it('clears a typed master password when the popup closes',async()=>{
 locked=true;await mount();value('#popup-master-password','Synthetic8!');window.dispatchEvent(new Event('pagehide'));
 expect(el<HTMLInputElement>('#popup-master-password').value).toBe('');
});
it('offers direct unlock in a locked persistent editor before loading any draft',async()=>{
 locked=true;await mount('?editor=login&id=login%20%26%20one');expect(el('#vault-unlock-panel').hidden).toBe(false);
 expect(el('#new-login-form').hidden).toBe(true);expect(sent.some(message=>message.type==='qf.get_profiles')).toBe(false);
 value('#popup-master-password','Synthetic8!');el('#vault-unlock-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
 expect(el<HTMLInputElement>('#nl-password').value).toBe('synthetic-password');expect(el('#vault-unlock-panel').hidden).toBe(true);
});
it('toolbar master-password eye closes when input resumes or the form is submitted',async()=>{
 locked=true;await mount();value('#popup-master-password','Synthetic8!');const master=el<HTMLInputElement>('#popup-master-password');
 await click('#popup-master-reveal');expect(master.type).toBe('text');master.dispatchEvent(new Event('paste'));expect(master.type).toBe('password');
 await click('#popup-master-reveal');el('#vault-unlock-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(master.type).toBe('password');expect(master.value).toBe('');
});
it('warns about legacy plaintext passwords without automatically opening management or migrating',async()=>{
 await mount();expect(el('#popup-legacy-warning').hidden).toBe(false);expect(el('#popup-legacy-count').textContent).toContain('1');
 expect(sent.some(m=>m.type==='qf.vault_setup')).toBe(false);expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();await click('#popup-legacy-migrate');expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
});
