import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { installChromeMock, type Harness, PENDING_KEY } from './helpers/chrome-mock';

let cap: typeof import('../src/content/capture');
let Banner: typeof import('../src/content/save-banner').SaveBanner;
let h: Harness;
let dispose: () => void;
const drain = async () => { for (let n = 0; n < 4; n++) await new Promise(r => setTimeout(r, 0)); };
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '';
  h = installChromeMock();
  cap = await import('../src/content/capture');
  Banner = (await import('../src/content/save-banner')).SaveBanner;
  dispose = cap.attachCapture();
});
afterEach(() => { dispose(); cap._resetForTests(); });
function fixture() {
  document.body.innerHTML = '<main><section><div><input autocomplete="username" value="synthetic-user"></div><div><input type="password" value="synthetic-password"></div><div><button type="button">Continue</button></div></section></main>';
  return {pw: document.querySelector<HTMLInputElement>('input[type=password]')!, button: document.querySelector('button')!};
}
it('captures nested sibling fields on a credible generic SPA authentication button', async () => {
  const {pw, button} = fixture();
  cap.recordPasswordFocus(pw);
  button.click();
  await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:'synthetic-user', password:'synthetic-password'});
  expect(Banner.current()?.isShown()).toBe(true);
});
it('captures a native submit even when focus was already present at content injection', async () => {
  document.body.innerHTML = '<form><input autocomplete="username" value="synthetic-user"><input type="password" value="synthetic-password"></form>';
  document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true}));
  await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:'synthetic-user',password:'synthetic-password'});
});
it('restores an already pending prompt after the SPA removes its host', async () => {
  const {pw, button} = fixture();
  cap.recordPasswordFocus(pw); button.click(); await drain();
  expect(Banner.current()?.isShown()).toBe(true);
  document.documentElement.lastElementChild!.remove();
  await drain();
  expect(Banner.current()?.isShown()).toBe(true);
  expect(Banner.current()?.getCard()?.isConnected).toBe(true);
});
it('does not revive a dismissed operation after DOM changes or route events', async () => {
  const {pw, button} = fixture();
  cap.recordPasswordFocus(pw); button.click(); await drain();
  expect(Banner.current()).not.toBeNull();
  await Banner.current()!.dismiss();
  document.body.append(document.createElement('div'));
  window.dispatchEvent(new PopStateEvent('popstate'));
  await drain();
  expect(Banner.current()).toBeNull();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});
it('does not turn navigation or unrelated controls into a new login candidate', async () => {
  const {pw} = fixture(); cap.recordPasswordFocus(pw);
  const unrelated = document.createElement('button'); unrelated.textContent = 'Continue'; document.body.append(unrelated);
  unrelated.click(); window.dispatchEvent(new PopStateEvent('popstate')); await drain();
  expect(h.sent.filter(m => m.type === 'qf.pending_put')).toHaveLength(0);
});
it('never stages a password just because the user types or leaves the page', async () => {
  const {pw} = fixture(); cap.recordPasswordFocus(pw); cap.trackInput(pw);
  window.dispatchEvent(new Event('pagehide')); await drain();
  expect(h.sent.filter(m => m.type === 'qf.pending_put')).toHaveLength(0);
});
it('associates an explicit username step only within the same surviving role-form', async () => {
  document.body.innerHTML = '<section role="form"><input autocomplete="username" value="step-user"><button type="button">Next</button></section>';
  const scope = document.querySelector('section')!;
  document.querySelector('button')!.click();
  expect(h.sent.some(m => m.type === 'qf.pending_put')).toBe(false);
  scope.innerHTML = '<input type="password" value="step-password"><button type="button">Continue</button>';
  const pw = scope.querySelector('input')!;
  cap.recordPasswordFocus(pw); scope.querySelector('button')!.click(); await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:'step-user', password:'step-password'});
});
it('never transfers a username step into a different authentication component', async () => {
  document.body.innerHTML = '<section role="form"><input autocomplete="username" value="wrong-user"><button type="button">Next</button></section><section role="form"><input type="password" value="other-password"><button type="button">Continue</button></section>';
  document.querySelector('button')!.click();
  const second = document.querySelectorAll('section')[1]!;
  cap.recordPasswordFocus(second.querySelector('input')!); second.querySelector('button')!.click(); await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:'', password:'other-password'});
});
it('waits for browser validity on a JavaScript button that calls requestSubmit', async () => {
  document.body.innerHTML = '<form><input type="email" autocomplete="username" value="invalid-email" required><input type="password" value="synthetic-password"><button type="button">Continue</button></form>';
  const form = document.querySelector('form')!;
  const button = document.querySelector('button')!;
  button.addEventListener('click', () => form.requestSubmit());
  cap.recordPasswordFocus(document.querySelector('input[type=password]') as HTMLInputElement);
  button.click(); await drain();
  expect(form.matches(':invalid')).toBe(true);
  expect(h.sent.some(m => m.type === 'qf.pending_put')).toBe(false);
});
it('does not display a late pending-put acknowledgement after clear invalidates it', async () => {
  const {pw,button} = fixture();
  const original = chrome.runtime.sendMessage;
  let release: (() => void) | undefined;
  (chrome.runtime as any).sendMessage = (message:any, cb:any) => {
    if (message.type === 'qf.pending_put') return (original as any)(message, (response:any) => {release = () => cb(response);});
    return (original as any)(message, cb);
  };
  cap.recordPasswordFocus(pw); button.click(); await drain();
  expect(release).toBeTypeOf('function');
  cap.clearPending(); release!(); await drain();
  expect(Banner.current()).toBeNull();
});
it('rechecks signup policy when a pending acknowledgement arrives after an SPA transition', async () => {
  const {pw,button} = fixture();
  const original = chrome.runtime.sendMessage;
  let release: (() => void) | undefined;
  (chrome.runtime as any).sendMessage = (message:any, cb:any) => {
    if (message.type === 'qf.pending_put') return (original as any)(message, (response:any) => {release = () => cb(response);});
    return (original as any)(message, cb);
  };
  cap.recordPasswordFocus(pw); button.click(); await drain();
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  release!(); await drain();
  expect(Banner.current()).toBeNull();
  expect(h.store.has(PENDING_KEY)).toBe(true);
});
it('hides an existing prompt when an SPA renders a registration form without focusing', async () => {
  const {pw,button} = fixture(); cap.recordPasswordFocus(pw); button.click(); await drain();
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  await drain();
  expect(Banner.current()).toBeNull();
  expect(h.store.has(PENDING_KEY)).toBe(true);
});
it('restores retry controls if the page removes the prompt while a save fails', async () => {
  const {pw,button} = fixture(); cap.recordPasswordFocus(pw); button.click(); await drain();
  const shown = Banner.current()!;
  const original = chrome.runtime.sendMessage;
  let fail: (() => void) | undefined;
  (chrome.runtime as any).sendMessage = (message:any, cb:any) => {
    if (message.type === 'qf.pending_save') {fail = () => cb({type:'qf.error',message:'Synthetic failure'}); return;}
    return (original as any)(message, cb);
  };
  const saving = shown.save();
  document.documentElement.lastElementChild!.remove(); await drain();
  fail!(); await saving; await drain();
  expect(shown.isShown()).toBe(true);
  expect(shown.getCard()?.textContent).toContain('Synthetic failure');
  expect(shown.getCard()?.querySelector('button')?.disabled).toBe(false);
  expect(h.store.has(PENDING_KEY)).toBe(true);
});
it('does not use an expired username step', async () => {
  document.body.innerHTML = '<section role="form"><input autocomplete="username" value="stale-user"><button type="button">Next</button></section>';
  const scope = document.querySelector('section')!;
  document.querySelector('button')!.click();
  const now = Date.now(); const clock = vi.spyOn(Date,'now').mockReturnValue(now+121000);
  scope.innerHTML = '<input type="password" value="synthetic-password"><button type="button">Continue</button>';
  cap.recordPasswordFocus(scope.querySelector('input')!); scope.querySelector('button')!.click(); await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:''});
  clock.mockRestore();
});
it('captures an explicitly marked password after the site reveals it as text', async () => {
  document.body.innerHTML = '<form><input autocomplete="username" value="synthetic-user"><input type="text" autocomplete="current-password" value="synthetic-password"></form>';
  document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true})); await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({username:'synthetic-user',password:'synthetic-password'});
});
it.each(['hidden',''])('keeps an unrelated %s signup widget separate from the submitted login', async visibility => {
  document.body.innerHTML = `<form id="login"><input autocomplete="username" value="synthetic-user"><input type="password" value="synthetic-password"></form><form ${visibility}><input type="password" autocomplete="new-password"></form>`;
  document.querySelector('#login')!.dispatchEvent(new Event('submit',{bubbles:true})); await drain();
  expect(Banner.current()?.isShown()).toBe(true);
});
it('rechecks registration policy after a delayed pending-get replay response', async () => {
  h.store.set(PENDING_KEY,{id:'synthetic-operation',origin:location.origin,username:'synthetic-user',password:'synthetic-password',createdAt:Date.now()});
  const original = chrome.runtime.sendMessage;
  let release:(() => void)|undefined;
  (chrome.runtime as any).sendMessage = (message:any,cb:any) => {
    if (message.type === 'qf.pending_get') return (original as any)(message,(response:any) => {release = () => cb(response);});
    return (original as any)(message,cb);
  };
  const replay = cap.flushPendingBanner(); await drain();
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  release!(); await replay;
  expect(Banner.current()).toBeNull();
  expect(h.store.has(PENDING_KEY)).toBe(true);
});
it('does not combine a password-only widget with a neighboring newsletter', async () => {
  document.body.innerHTML = '<main><section><input type="password" value="synthetic-password"><button type="button">Continue</button></section><section><input type="email" value="unrelated@example.test"><button type="button">Subscribe</button></section></main>';
  cap.recordPasswordFocus(document.querySelector('input')!); document.querySelector('button')!.click(); await drain();
  expect(h.sent.some(m => m.type === 'qf.pending_put')).toBe(false);
});
