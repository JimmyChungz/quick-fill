import { afterEach, beforeEach, expect, it } from 'vitest';
import { attachCapture, clearPending, recordPasswordFocus, trackInput } from '../src/content/capture';
import { SaveBanner } from '../src/content/save-banner';
import { installChromeMock, PENDING_KEY } from './helpers/chrome-mock';

const h = installChromeMock();
const drain = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let detach: () => void;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

function login(action = 'Connexion'): HTMLInputElement {
  document.body.innerHTML = `<section id="auth"><div><input id="u" autocomplete="username" value="synthetic@example.test"></div><div><input id="p" type="password" autocomplete="section-login current-password" value="synthetic-password"></div><div><button id="go" type="button">${action}</button></div></section><textarea id="notes"></textarea><input id="outside">`;
  const p = field('p');
  recordPasswordFocus(p);
  trackInput(p);
  return p;
}

function enter(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  clearPending();
  document.body.innerHTML = '';
  await drain();
  h.store.clear();
  h.sent.length = 0;
  detach = attachCapture();
});
afterEach(() => { detach(); clearPending(); });

it.each(['Connexion', 'ログイン', 'Iniciar sesión'])('captures a scoped localized %s click', async label => {
  login(label);
  field('go').click();
  await drain();
  expect(SaveBanner.current()?.isShown()).toBe(true);
  expect(h.store.get(PENDING_KEY)).toMatchObject({ username: 'synthetic@example.test', password: 'synthetic-password' });
});

it('captures Enter in one semantic formless password without suppressing the page event', async () => {
  const p = login();
  const event = enter(p);
  await drain();
  expect(event.defaultPrevented).toBe(false);
  expect(SaveBanner.current()?.isShown()).toBe(true);
  expect(h.store.get(PENDING_KEY)).toMatchObject({ username: 'synthetic@example.test', password: 'synthetic-password' });
});

it.each(['u', 'notes', 'outside', 'go'])('does not capture Enter in %s merely because a password was focused before', async id => {
  login();
  enter(field(id));
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});

it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { key: 'Escape' }])('ignores a modified, repeated, composing or non-Enter event: %j', async init => {
  enter(login(), init);
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});

it.each(['Subscribe', 'Register', 'Create account', 'Show password', 'Cancel', 'Back', 'Save draft'])('does not infer Enter or click login intent from %s', async label => {
  enter(login(label));
  field('go').click();
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});

it.each(['new-password', '', 'unknown current-password', 'one-time-code'])('requires valid explicit current-password semantics for Enter (%s)', async autocomplete => {
  const p = login();
  p.setAttribute('autocomplete', autocomplete);
  enter(p);
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});

it.each(['extra-password', 'extra-account', 'unknown-action', 'no-action', 'empty-password', 'empty-account', 'readonly', 'disabled'])('rejects an ambiguous or incomplete formless Enter scope (%s)', async change => {
  const p = login();
  const auth = document.getElementById('auth')!;
  if (change === 'extra-password') auth.insertAdjacentHTML('beforeend', '<input type="password" autocomplete="current-password">');
  if (change === 'extra-account') auth.insertAdjacentHTML('beforeend', '<input autocomplete="username">');
  if (change === 'unknown-action') auth.insertAdjacentHTML('beforeend', '<button type="button">Save draft</button>');
  if (change === 'no-action') field('go').remove();
  if (change === 'empty-password') p.value = '';
  if (change === 'empty-account') field('u').value = '';
  if (change === 'readonly') p.readOnly = true;
  if (change === 'disabled') p.disabled = true;
  enter(p);
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
});

it('leaves native-form Enter capture to the validated submit event', async () => {
  document.body.innerHTML = '<form id="native"><input autocomplete="username" type="email" required value="invalid"><input id="p" type="password" autocomplete="current-password" value="synthetic-password"><button>Connexion</button></form>';
  const p = field('p');
  recordPasswordFocus(p);
  enter(p);
  await drain();
  expect(h.store.has(PENDING_KEY)).toBe(false);
  field('native').querySelector<HTMLInputElement>('input')!.value = 'synthetic@example.test';
  field('native').dispatchEvent(new Event('submit', { bubbles: true }));
  await drain();
  expect(h.store.get(PENDING_KEY)).toMatchObject({ username: 'synthetic@example.test', password: 'synthetic-password' });
});
