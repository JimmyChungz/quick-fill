// Policy spec for the credential-capture pipeline.
//
// Product intent (confirmed with the owner 2026-09-14): the prompt is raised at
// the moment the user submits the login form, INCLUDING failed attempts — we
// cannot reliably detect "login succeeded", and asking always guarantees we
// never miss a save opportunity. What makes that practical is not guessing
// success, but three guards:
//   1. never ask about a credential we already hold verbatim;
//   2. when the same origin+username exists with a different password, ask as an
//      UPDATE (overwrite in place) so a later correct login repairs the record
//      instead of piling up duplicate rows;
//   3. never ask on sign-up / change-password forms, and never across sites.
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { installChromeMock, loginProfile, PENDING_KEY, STORE_KEY, type Harness } from './helpers/chrome-mock';
import { SaveBanner } from '../src/content/save-banner';
import type { Stored } from '../src/lib/types';

const ORIGIN = 'http://localhost:3000';
const OTHER_ORIGIN = 'https://other.example';

let h: Harness;
let capture!: typeof import('../src/content/capture');

beforeAll(async () => {
  h = installChromeMock();
  await import('../src/content/index'); // registers the real listeners
  capture = await import('../src/content/capture');
});

const drain = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(async () => {
  document.body.innerHTML = '';
  await drain();                 // let the MutationObserver settle
  h.store.clear();
  h.sent.length = 0;
  capture._resetForTests();
});

function bannerHost(): HTMLElement | null {
  // The banner lives in a CLOSED shadow root, so the DOM can no longer be used
  // to reach it (that is the whole point of N4). Tests go through the instance
  // hook instead — otherwise every "no banner" assertion would pass vacuously.
  return SaveBanner.current()?.getCard() ?? null;
}

function bannerText(): string {
  return bannerHost()?.textContent ?? '';
}

function bannerButtons(): { save: HTMLElement; block: HTMLElement; close: HTMLElement } {
  const card = bannerHost()!;
  const row = Array.from(card.querySelectorAll('.row button')) as HTMLElement[];
  return { save: row[0]!, block: row[1]!, close: card.querySelector('.close') as HTMLElement };
}

const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

function pwField(attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'password';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function userField(attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** A plain login form (no attribute that would make it look like sign-up). */
function loginForm(): { form: HTMLFormElement; u: HTMLInputElement; p: HTMLInputElement } {
  const form = document.createElement('form');
  const u = userField({ name: 'username' });
  const p = pwField({ name: 'password' });
  form.append(u, p);
  document.body.appendChild(form);
  return { form, u, p };
}

/** Focus + type a credential the way the content script observes it. */
function typeLogin(u: HTMLInputElement, p: HTMLInputElement, username: string, password: string): void {
  capture.recordCredentialFocus(u);
  u.value = username;
  capture.trackInput(u);
  capture.recordPasswordFocus(p);
  p.value = password;
  capture.trackInput(p);
}

const submit = (el: HTMLElement) => el.dispatchEvent(new Event('submit', { bubbles: true }));

describe('capture policy — at submit time', () => {
  it('asks even though there is no success signal (failed logins included)', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    const { u, p } = loginForm();
    typeLogin(u, p, 'alice', 'secret');
    submit(p);
    await drain();
    expect(bannerHost()).not.toBeNull();
    expect(bannerText()).toContain('保存');
  });

  it('does not ask again for a credential already stored verbatim', async () => {
    h.setStored({
      version: 1,
      blacklist: [],
      profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })],
    });
    const { u, p } = loginForm();
    typeLogin(u, p, 'alice', 'secret');
    submit(p);
    await drain();
    expect(bannerHost()).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });

  it('asks as an UPDATE that overwrites the same row when only the password changed', async () => {
    h.setStored({
      version: 1,
      blacklist: [],
      profiles: [loginProfile({ id: 'keep-me', url: ORIGIN, username: 'alice', password: 'old-pw' })],
    });
    const { u, p } = loginForm();
    typeLogin(u, p, 'alice', 'new-pw');
    submit(p);
    await drain();

    expect(bannerText()).toContain('更新');
    click(bannerButtons().save);
    await drain();

    const stored = h.store.get(STORE_KEY) as Stored;
    expect(stored.profiles).toHaveLength(1);
    expect(stored.profiles[0]).toMatchObject({ id: 'keep-me', password: 'new-pw' });
  });

  it('adds a second row when the username differs (multi-account)', async () => {
    h.setStored({
      version: 1,
      blacklist: [],
      profiles: [loginProfile({ id: 'first', url: ORIGIN, username: 'alice', password: 'secret' })],
    });
    const { u, p } = loginForm();
    typeLogin(u, p, 'bob', 'bob-pw');
    submit(p);
    await drain();
    click(bannerButtons().save);
    await drain();

    const stored = h.store.get(STORE_KEY) as Stored;
    expect(stored.profiles).toHaveLength(2);
    expect(stored.profiles.map((x) => x.id)).toContain('first');
  });

  it('never asks on a sign-up / change-password form', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    const form = document.createElement('form');
    const u = userField({ autocomplete: 'username' });
    const p1 = pwField({ autocomplete: 'new-password' });
    const p2 = pwField({ autocomplete: 'new-password' });
    form.append(u, p1, p2);
    document.body.appendChild(form);
    capture.recordCredentialFocus(u);
    capture.recordPasswordFocus(p1);
    p1.value = 'brand-new';
    capture.trackInput(p1);
    submit(p1);
    await drain();
    expect(bannerHost()).toBeNull();
  });

  it('never asks on an already-blacklisted origin', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [ORIGIN] });
    const { u, p } = loginForm();
    typeLogin(u, p, 'alice', 'secret');
    submit(p);
    await drain();
    expect(bannerHost()).toBeNull();
  });

  it('captures the field the user typed into, not the first password input in the document', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    // SPA-style page without a <form>: a stray password input sits earlier in
    // the DOM than the one being typed into (so the scope falls back to document).
    const stray = pwField({ name: 'confirm_password' });
    stray.value = 'STALE';
    document.body.appendChild(stray);
    const wrapper = document.createElement('div');
    const real = pwField({ name: 'password' });
    wrapper.appendChild(real);
    document.body.appendChild(wrapper);
    real.value = 'what-i-typed';

    capture.recordPasswordFocus(real);
    capture.trackInput(real);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '登录'; wrapper.appendChild(button); button.click();
    await drain();

    const buf = h.store.get(PENDING_KEY) as { password: string } | undefined;
    expect(buf?.password).toBe('what-i-typed');
  });

  it('keeps the persisted candidate even though the banner is shown on this page', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    const { u, p } = loginForm();
    typeLogin(u, p, 'alice', 'secret');
    submit(p);
    await drain();
    expect(bannerHost()).not.toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(true);
  });

  it.each(['save', 'block', 'close'] as const)(
    'stops pestering the next page once the user acts (%s)',
    async (which) => {
      h.setStored({ version: 1, profiles: [], blacklist: [] });
      const { u, p } = loginForm();
      typeLogin(u, p, 'alice', 'secret');
      submit(p);
      await drain();
      click(bannerButtons()[which]);
      await drain();
      expect(bannerHost()).toBeNull();
      expect(h.store.has(PENDING_KEY)).toBe(false);
    },
  );
});

describe('capture policy — next page flush', () => {
  const pending = (origin: string, extra: Record<string, unknown> = {}) => ({
    origin, username: 'alice', password: 'secret', createdAt: Date.now(), ...extra,
  });

  it('re-shows the prompt on the same origin after a navigation', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    h.store.set(PENDING_KEY, pending(ORIGIN));
    await capture.flushPendingBanner();
    expect(bannerHost()).not.toBeNull();
  });

  it('refuses to show another site\'s candidate (and leaves it for that site)', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    h.store.set(PENDING_KEY, pending(OTHER_ORIGIN));
    await capture.flushPendingBanner();
    expect(bannerHost()).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(true);
  });

  it('drops the candidate silently when it is already stored', async () => {
    h.setStored({
      version: 1,
      blacklist: [],
      profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })],
    });
    h.store.set(PENDING_KEY, pending(ORIGIN));
    await capture.flushPendingBanner();
    expect(bannerHost()).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });

  it('drops an expired candidate', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [] });
    h.store.set(PENDING_KEY, pending(ORIGIN, { createdAt: Date.now() - 10 * 60 * 1000 }));
    await capture.flushPendingBanner();
    expect(bannerHost()).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });

  it('stays silent on a blacklisted origin and clears the candidate', async () => {
    h.setStored({ version: 1, profiles: [], blacklist: [ORIGIN] });
    h.store.set(PENDING_KEY, pending(ORIGIN));
    await capture.flushPendingBanner();
    expect(bannerHost()).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });
});
