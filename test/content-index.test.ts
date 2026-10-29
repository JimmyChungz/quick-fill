// Integration spec for the content-script focus/pick flow (src/content/index.ts).
// This is the surface where the "focus the username box, pick a saved login"
// path lives — previously untested (the old suite only asserted
// `typeof mod === 'object'`).
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { installChromeMock, loginProfile, STORE_KEY, type Harness } from './helpers/chrome-mock';
import type { IdentityProfile, Stored } from '../src/lib/types';
import { Suggest } from '../src/content/suggest';
import { SaveBanner } from '../src/content/save-banner';

const ORIGIN = 'http://localhost:3000';

let content!: typeof import('../src/content/index');
let h: Harness;

beforeAll(async () => {
  h = installChromeMock();
  content = await import('../src/content/index');
});

const drain = () => new Promise<void>((r) => setTimeout(r, 0));

async function seed(stored: Stored): Promise<void> {
  await (globalThis as unknown as {
    chrome: { storage: { local: { set(o: Record<string, unknown>): Promise<void> } } };
  }).chrome.storage.local.set({ [STORE_KEY]: stored });
  await drain();
}

beforeEach(async () => {
  document.body.innerHTML = '';
  await drain();
  void content;
});

function suggestHost(): HTMLElement | null {
  return Suggest.current()?.getHost() ?? null;
}

function suggestItems(): HTMLElement[] {
  // Suggest is in closed shadow (N4 fix); reach the card via the public getter.
  const s = Suggest.current();
  if (!s) return [];
  const card = s.getCard();
  if (!card) return [];
  return Array.from(card.querySelectorAll('.item')) as HTMLElement[];
}

function closeSuggest(): void {
  const host = suggestHost();
  if (host) host.remove();
}

const focus = (el: HTMLElement) => el.dispatchEvent(new Event('focusin', { bubbles: true }));
const clickItem = async (el: HTMLElement) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await drain(); };

function loginForm(): { form: HTMLFormElement; u: HTMLInputElement; p: HTMLInputElement } {
  const form = document.createElement('form');
  const u = document.createElement('input');
  u.type = 'text';
  u.name = 'username';
  const p = document.createElement('input');
  p.type = 'password';
  p.name = 'password';
  form.append(u, p);
  document.body.appendChild(form);
  return { form, u, p };
}

const EMPTY: Stored = { version: 1, profiles: [], blacklist: [] };

describe('content script — picking a saved login', () => {
  it('fills the whole login when the user picks from the username field', async () => {
    await seed({ ...EMPTY, profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })] });
    const { u, p } = loginForm();
    focus(u);
    expect(suggestItems()).toHaveLength(1);
    await clickItem(suggestItems()[0]!);
    expect(u.value).toBe('alice');
    expect(p.value).toBe('secret');
  });

  it('never clobbers a password the user already typed', async () => {
    await seed({ ...EMPTY, profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })] });
    const { u, p } = loginForm();
    p.value = 'typed-by-hand';
    focus(u);
    await clickItem(suggestItems()[0]!);
    expect(u.value).toBe('alice');
    expect(p.value).toBe('typed-by-hand');
  });

  it('fills both boxes when the user picks from the password field (control)', async () => {
    await seed({ ...EMPTY, profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })] });
    const { u, p } = loginForm();
    focus(p);
    await clickItem(suggestItems()[0]!);
    expect(u.value).toBe('alice');
    expect(p.value).toBe('secret');
  });

  it('serves only logins for the current origin', async () => {
    await seed({
      ...EMPTY,
      profiles: [
        loginProfile({ id: 'here', url: ORIGIN, username: 'alice', password: 's' }),
        loginProfile({ id: 'elsewhere', url: 'https://other.example', username: 'bob', password: 's' }),
      ],
    });
    const { p } = loginForm();
    focus(p);
    const items = suggestItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('alice');
  });

  it('still offers and fills credentials on a blacklisted origin (blocking save != blocking fill)', async () => {
    await seed({
      version: 1,
      blacklist: [ORIGIN],
      profiles: [loginProfile({ url: ORIGIN, username: 'alice', password: 'secret' })],
    });
    const { u, p } = loginForm();
    focus(p);
    expect(suggestItems()).toHaveLength(1);
    await clickItem(suggestItems()[0]!);
    expect(u.value).toBe('alice');
    expect(p.value).toBe('secret');
  });

  it('shows no popup for an empty login list', async () => {
    await seed(EMPTY);
    const { p } = loginForm();
    focus(p);
    expect(suggestHost()).toBeNull();
  });
});

describe('content script — deferred surfaces', () => {
  const identity: IdentityProfile = {
    id: 'I1', kind: 'identity', label: '家庭',
    fields: { email: 'a@b.c', tel: '123' }, updatedAt: 1,
  };

  it('does not pop up on a <select>, which the filler cannot fill yet', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    const sel = document.createElement('select');
    sel.name = 'country';
    document.body.appendChild(sel);
    focus(sel);
    expect(suggestHost()).toBeNull();
  });

  it('closes the popup when the user mouses down outside it', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email';
    form.appendChild(email);
    document.body.appendChild(form);
    focus(email);
    expect(suggestHost()).not.toBeNull();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(suggestHost()).toBeNull();
  });

  it('repositions instead of detaching when the page scrolls', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email';
    form.appendChild(email);
    document.body.appendChild(form);
    focus(email);
    const host = suggestHost()!;
    expect(host).not.toBeNull();
    window.dispatchEvent(new Event('scroll'));
    await drain();
    // still shown (no re-render), just moved
    expect(suggestHost()).toBe(host);
    closeSuggest();
  });
});

describe('content script — v2 N10 (only show identities that match)', () => {
  it('hides an identity whose fields do not overlap the current form', async () => {
    await seed({
      ...EMPTY,
      profiles: [{
        id: 'rich', kind: 'identity', label: 'rich', updatedAt: 1,
        fields: { email: 'a@b.c', tel: '555', name: 'Alice' },
      }],
    });
    const form = document.createElement('form');
    const city = document.createElement('input'); city.name = 'city';
    form.appendChild(city);
    document.body.appendChild(form);
    focus(city);
    expect(suggestItems()).toHaveLength(0);
  });

  it('lists an identity when at least one of its fields is on the form, and shows match count', async () => {
    await seed({
      ...EMPTY,
      profiles: [{
        id: 'mix', kind: 'identity', label: 'mix', updatedAt: 1,
        fields: { email: 'a@b.c', name: 'Alice', city: 'Beijing' },
      }],
    });
    const form = document.createElement('form');
    const email = document.createElement('input'); email.type = 'email';
    const city = document.createElement('input'); city.name = 'city';
    form.append(email, city);
    document.body.appendChild(form);
    focus(email);
    const items = suggestItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('mix');
    expect(items[0]!.textContent).toContain('2/3');
  });
});

describe('content script — v2 N7 (sort by recency)', () => {
  it.each([false, true])('lists identities by use time with legacy fallback (metadata %s)', async withUseTime => {
    await seed({
      ...EMPTY,
      profiles: [
        { id: 'old', kind: 'identity', label: 'old', updatedAt: withUseTime ? 200 : 1, ...(withUseTime ? { lastUsedAt: 10 } : {}), fields: { email: 'o@x' } },
        { id: 'new', kind: 'identity', label: 'new', updatedAt: 99, ...(withUseTime ? { lastUsedAt: 300 } : {}), fields: { email: 'n@x' } },
        { id: 'mid', kind: 'identity', label: 'mid', updatedAt: 50, fields: { email: 'm@x' } },
      ],
    });
    const form = document.createElement('form');
    const email = document.createElement('input'); email.type = 'email';
    form.appendChild(email);
    document.body.appendChild(form);
    focus(email);
    const labels = suggestItems().map((i) => i.textContent ?? '');
    expect(labels[0]).toContain('new');
    expect(labels[1]).toContain('mid');
    expect(labels[2]).toContain('old');
  });
});

describe('content script — label truthfulness (N10 + N1)', () => {
  const identity: IdentityProfile = {
    id: 'I1', kind: 'identity', label: '家庭',
    fields: { email: 'saved@example.com', tel: '13800000000' }, updatedAt: 1,
  };

  it('counts only fields it can actually write, not every matching token', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email';
    email.name = 'email';
    email.value = '我手打的@mail.com';          // user already typed here
    const tel = document.createElement('input');
    tel.type = 'tel';
    tel.name = 'phone';
    form.append(email, tel);
    document.body.appendChild(form);

    focus(email);
    const label = suggestItems()[0]?.textContent ?? '';
    // Two tokens match, but only the empty one will be written — the label must
    // not promise two.
    expect(label).toContain('可填 1/2');
  });

  it('still promises both when both are empty', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email'; email.name = 'email';
    const tel = document.createElement('input');
    tel.type = 'tel'; tel.name = 'phone';
    form.append(email, tel);
    document.body.appendChild(form);

    focus(email);
    expect(suggestItems()[0]?.textContent ?? '').toContain('可填 2/2');
  });
});

describe('content script — fill coverage across forms (N5 trade-off)', () => {
  const identity: IdentityProfile = {
    id: 'I1', kind: 'identity', label: '家庭',
    fields: { email: 'saved@example.com', 'postal-code': '310000' }, updatedAt: 1,
  };

  it('keeps matching fields outside the focused form untouched', async () => {
    await seed({ ...EMPTY, profiles: [identity] });
    // The user focuses a field in form A...
    const formA = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email'; email.name = 'email';
    formA.appendChild(email);
    document.body.appendChild(formA);
    // ...but the matching zip lives in a different form further down the page.
    const formB = document.createElement('form');
    const zip = document.createElement('input');
    zip.type = 'text'; zip.name = 'zip';
    formB.appendChild(zip);
    document.body.appendChild(formB);

    focus(email);
    await clickItem(suggestItems()[0]!);

    expect(email.value).toBe('saved@example.com');
    expect(zip.value).toBe('');
  });
});

describe('content script — popup is unreachable from page script (N4)', () => {
  it('exposes no shadowRoot and no text to the page', async () => {
    await seed({
      ...EMPTY,
      profiles: [{ id: 'L1', kind: 'login', url: ORIGIN, username: 'alice', password: 'pw', updatedAt: 1 }],
    });
    const { p } = loginForm();
    focus(p);
    expect(suggestItems().length).toBe(1);

    const host = suggestHost()!;
    expect((host as unknown as { shadowRoot: ShadowRoot | null }).shadowRoot).toBeNull();
    expect(document.documentElement.textContent ?? '').not.toContain('alice');
  });
});
it('dismisses an open suggestion when a profile is deleted or changed',async()=>{
 await seed({...EMPTY,profiles:[loginProfile({url:ORIGIN})]});
 const {p}=loginForm();focus(p);expect(Suggest.current()?.isShown()).toBe(true);
 await seed(EMPTY);expect(Suggest.current()?.isShown()??false).toBe(false);
});
it('fills a nested formless login using auth scope without broadening identity scope', async () => {
  await seed({...EMPTY,profiles:[loginProfile({url:ORIGIN,username:'synthetic-user',password:'synthetic-password'})]});
  document.body.innerHTML = '<section><div><input autocomplete="username"></div><div><input type="password"></div><div><button type="button">Continue</button></div></section>';
  const [u,p] = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  focus(p!); await clickItem(suggestItems()[0]!);
  expect(u!.value).toBe('synthetic-user');
  expect(p!.value).toBe('synthetic-password');
});

it('uses only metadata until a selection and never reads local or session storage from content', async () => {
  const localRead = vi.spyOn(chrome.storage.local, 'get').mockRejectedValue(new Error('content storage prohibited'));
  const sessionRead = vi.spyOn(chrome.storage.session, 'get').mockRejectedValue(new Error('content storage prohibited'));
  const messages = vi.spyOn(chrome.runtime, 'sendMessage');
  try {
    await seed({ ...EMPTY, profiles: [loginProfile({ url: ORIGIN, password: 'synthetic-selected-secret' })] });
    const { p } = loginForm(); focus(p);
    expect(messages.mock.calls.some(([msg]) => (msg as any).type === 'qf.content_profiles')).toBe(true);
    expect(messages.mock.calls.some(([msg]) => (msg as any).type === 'qf.fill_profile')).toBe(false);
    expect(p.value).toBe('');
    await clickItem(suggestItems()[0]!);
    expect(p.value).toBe('synthetic-selected-secret');
    expect(messages.mock.calls.filter(([msg]) => (msg as any).type === 'qf.fill_profile')).toHaveLength(1);
    expect(messages.mock.calls.some(([msg]) => (msg as any).type === 'qf.get_profiles' || (msg as any).type === 'qf.touch_profile')).toBe(false);
    expect(localRead).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  } finally { localRead.mockRestore(); sessionRead.mockRestore(); messages.mockRestore(); }
});

it('discards a delayed selected password if a lock notification arrives first', async () => {
  await seed({ ...EMPTY, profiles: [loginProfile({ url: ORIGIN, password: 'synthetic-delayed-secret' })] });
  const { u, p } = loginForm(); focus(p);
  const original = chrome.runtime.sendMessage;
  let release: (() => void) | undefined;
  const intercept = vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(((msg:any, cb:any) => {
    if (msg.type === 'qf.fill_profile') return (original as any)(msg, (response:any) => { release = () => cb(response); });
    return (original as any)(msg, cb);
  }) as any);
  try {
    const picking = clickItem(suggestItems()[0]!);
    await drain();
    expect(release).toBeTypeOf('function');
    h.deliver({ type: 'qf.data_changed', generation: 'new-lock-generation', locked: true });
    release!(); await picking;
    expect(u.value).toBe(''); expect(p.value).toBe('');
    expect(Suggest.current()?.isShown() ?? false).toBe(false);
  } finally { intercept.mockRestore(); }
});

it('keeps an independent save prompt after an ordinary write in another tab, but clears it on lock', async () => {
  await seed(EMPTY);
  const {form, u, p} = loginForm();
  u.value = 'synthetic-tab-b'; p.value = 'synthetic-only'; focus(p);
  form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  await drain();
  const banner = SaveBanner.current()!;
  expect(banner.isShown()).toBe(true);
  h.deliver({type: 'qf.data_changed', generation: '0', locked: false});
  await drain();
  expect(banner.isShown()).toBe(true);
  h.deliver({type: 'qf.data_changed', generation: 'next-lock', locked: true});
  expect(banner.isShown()).toBe(false);
});
