// Mechanism tests for the capture wiring (attachCapture / trackInput / SaveBanner).
// The prompt *policy* is specified in capture-policy.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachCapture, recordPasswordFocus, recordCredentialFocus, trackInput, _resetForTests,
} from '../src/content/capture';
import { SaveBanner } from '../src/content/save-banner';

import {installChromeMock, PENDING_KEY} from './helpers/chrome-mock';
const STORE_KEY = 'qf.stored.v1';
const h = installChromeMock();
const localStore = h.store;
const sentMessages = h.sent;

/** Flushes the whole async decision chain — the prompt path reads storage first. */
const drain = () => new Promise<void>((r) => setTimeout(r, 0));

function makeInput(type: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  let form = document.querySelector('form');
  if (!form) { form = document.createElement('form'); document.body.appendChild(form); }
  form.appendChild(el);
  return el;
}

const bannerCount = () =>
  Array.from(document.documentElement.children).filter((c) => c.tagName === 'DIV').length;

/** A realistic login form, wired the way the content script observes it. */
function typeCredentials(opts: { username?: string; password?: string } = {}) {
  const pw = makeInput('password', { name: 'password' });
  const user = makeInput('text', { name: 'username' });
  recordCredentialFocus(user);
  if (opts.username !== undefined) { user.value = opts.username; trackInput(user); }
  recordPasswordFocus(pw);
  if (opts.password !== undefined) { pw.value = opts.password; trackInput(pw); }
  return { pw, user };
}

beforeEach(async () => {
  document.documentElement.innerHTML = '';
  await drain();
  sentMessages.length = 0;
  localStore.clear();
  _resetForTests();
});

describe('capture pipeline', () => {
  it('shows the save banner on submit when a password is present', async () => {
    attachCapture();
    const { pw } = typeCredentials({ username: 'alice', password: 'secret' });
    pw.dispatchEvent(new Event('submit', { bubbles: true }));
    await drain();
    expect(bannerCount()).toBe(1);
  });

  it('keeps tracking the latest values up to the moment of submit', async () => {
    attachCapture();
    const pw = makeInput('password', { name: 'password' });
    const user = makeInput('text', { name: 'username' });
    recordPasswordFocus(pw);

    user.value = 'bob'; trackInput(user);
    user.value = 'bobby'; trackInput(user);
    pw.value = 'hunter2'; trackInput(pw);

    pw.dispatchEvent(new Event('submit', { bubbles: true }));
    await drain();

    expect(localStore.get(PENDING_KEY)).toMatchObject({ username: 'bobby', password: 'hunter2' });
  });

  it('skips the prompt when no password was entered', async () => {
    attachCapture();
    const pw = makeInput('password');
    recordPasswordFocus(pw);
    pw.dispatchEvent(new Event('submit', { bubbles: true }));
    await drain();
    expect(bannerCount()).toBe(0);
  });

  it('asks at most once per credential on the same page', async () => {
    attachCapture();
    const { pw } = typeCredentials({ username: 'alice', password: 'secret' });
    pw.dispatchEvent(new Event('submit', { bubbles: true }));
    await drain();
    expect(bannerCount()).toBe(1);

    const close = SaveBanner.current()?.getCard()?.querySelector('.close') as HTMLElement | undefined;
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await drain();

    recordPasswordFocus(pw);
    pw.value = 'secret';
    trackInput(pw);
    pw.dispatchEvent(new Event('submit', { bubbles: true }));
    await drain();
    expect(bannerCount()).toBe(0);
  });

  it('does not persist unsubmitted credentials on pagehide', async () => {
    attachCapture();
    typeCredentials({ username: 'alice', password: 'p' });
    window.dispatchEvent(new Event('pagehide'));
    await drain();
    expect(localStore.has(PENDING_KEY)).toBe(false);
  });
});

describe('capture.flushPendingBanner', () => {
  it('re-shows a candidate captured on this same origin', async () => {
    localStore.set(PENDING_KEY, {
      origin: window.location.origin, username: 'u', password: 'p', createdAt: Date.now(),
    });
    const { flushPendingBanner } = await import('../src/content/capture');
    expect(await flushPendingBanner()).toBe('shown');
    expect(bannerCount()).toBe(1);
    // Display is not acknowledgement: retain until save/dismiss succeeds.
    expect(localStore.has(PENDING_KEY)).toBe(true);
  });

  it('ignores an expired candidate', async () => {
    localStore.set(PENDING_KEY, {
      origin: window.location.origin, username: 'u', password: 'p',
      createdAt: Date.now() - 10 * 60 * 1000,
    });
    const { flushPendingBanner } = await import('../src/content/capture');
    expect(await flushPendingBanner()).toBe('none');
    expect(bannerCount()).toBe(0);
  });

  it('is a no-op when nothing is buffered', async () => {
    const { flushPendingBanner } = await import('../src/content/capture');
    expect(await flushPendingBanner()).toBe('none');
    expect(bannerCount()).toBe(0);
  });
});

describe('SaveBanner', () => {
  it('shows and hides', () => {
    const b = new SaveBanner();
    b.show({ origin: 'https://x.example', username: 'u', password: 'p' });
    expect(b.isShown()).toBe(true);
    expect(bannerCount()).toBe(1);
    b.hide();
    expect(b.isShown()).toBe(false);
    expect(bannerCount()).toBe(0);
  });

  it('keeps the banner (and the username in it) out of reach of page scripts', () => {
    const b = new SaveBanner();
    b.show({ origin: 'https://x.example', username: 'alice', password: 'p' });
    const host = Array.from(document.documentElement.children)
      .find((c) => c.tagName === 'DIV') as HTMLElement;
    expect(host).toBeDefined();
    // closed shadow root: the page cannot walk in
    expect((host as unknown as { shadowRoot: ShadowRoot | null }).shadowRoot).toBeNull();
    expect(document.documentElement.textContent ?? '').not.toContain('alice');
    b.hide();
  });

  it('does not touch the persisted record when merely re-rendering', () => {
    localStore.set(PENDING_KEY, { origin: 'https://x.example', password: 'p' });
    const b = new SaveBanner();
    b.show({ origin: 'https://x.example', username: 'u', password: 'p' });
    b.hide();
    expect(localStore.has(PENDING_KEY)).toBe(true);
  });

  it('save() asks the coordinator to save its specific operation', async () => {
    localStore.set(PENDING_KEY,{id:'fixture',origin:location.origin,username:'demo',password:'fake',createdAt:Date.now()});
    const b=new SaveBanner(); b.show({origin:location.origin,username:'demo',password:'fake',operationId:'fixture',generation:'0'});
    await b.save();expect(sentMessages).toMatchObject([{type:'qf.pending_save',id:'fixture'}]);
    expect(b.isShown()).toBe(false);
  });
  it('an ambiguous password-only operation never chooses an existing account', async () => {
    localStore.set(STORE_KEY,{version:1,profiles:[{id:'A',kind:'login',url:location.origin,username:'kept',password:'old',updatedAt:1}],blacklist:[]});
    localStore.set(PENDING_KEY,{id:'fixture',origin:location.origin,username:'',password:'new',createdAt:Date.now()});
    const b=new SaveBanner();b.show({origin:location.origin,username:'',password:'new',operationId:'fixture',generation:'0'});
    await b.save();expect((localStore.get(STORE_KEY) as any).profiles[0].password).toBe('old');
  });
  it('blacklist() applies to its specific pending operation',async()=>{
    localStore.set(PENDING_KEY,{id:'fixture',origin:location.origin,username:'demo',password:'fake',createdAt:Date.now()});
    const b=new SaveBanner();b.show({origin:location.origin,username:'demo',password:'fake',operationId:'fixture',generation:'0'});
    await b.blacklist();expect(sentMessages[0]).toMatchObject({type:'qf.pending_blacklist',id:'fixture'});expect(b.isShown()).toBe(false);
  });
  it('dismiss() acknowledges and drops its specific operation',async()=>{
    localStore.set(PENDING_KEY,{id:'fixture',origin:location.origin,username:'demo',password:'fake',createdAt:Date.now()});
    const b=new SaveBanner();b.show({origin:location.origin,username:'demo',password:'fake',operationId:'fixture',generation:'0'});
    await b.dismiss();expect(localStore.has(PENDING_KEY)).toBe(false);expect(b.isShown()).toBe(false);
  });
});
