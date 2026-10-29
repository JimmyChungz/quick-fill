// Guards the N8 fix: with the Navigation API present we must NOT patch
// history.pushState (that left `history.pushState.toString()` returning our own
// source, a source-level fingerprint). The fallback path still patches, so this
// has to run against a stubbed `window.navigation` before capture.ts is loaded.
//
// Ported from the one-off verification harness so the guarantee lives in the
// suite instead of in a scratch script.
import { describe, it, expect, beforeAll } from 'vitest';
import { installChromeMock, PENDING_KEY, type Harness } from './helpers/chrome-mock';

type Any = Record<string, any>;

let h: Harness;
let capture!: typeof import('../src/content/capture');
const navListeners: Array<{ type: string; cb: () => void }> = [];
const pushStateBefore = history.pushState;
const replaceStateBefore = history.replaceState;

beforeAll(async () => {
  h = installChromeMock();
  (window as unknown as Any).navigation = {
    addEventListener(type: string, cb: () => void) { navListeners.push({ type, cb }); },
    removeEventListener() { /* noop */ },
  };
  capture = await import('../src/content/capture');
  capture.attachCapture();
});

describe('SPA navigation detection (N8)', () => {
  it('leaves history.pushState / replaceState untouched when Navigation API exists', () => {
    expect(history.pushState).toBe(pushStateBefore);
    expect(history.replaceState).toBe(replaceStateBefore);
    expect(navListeners.map(x => x.type)).toEqual(['currententrychange']);
  });

  it('does not prompt on a route change without authentication submit', async () => {
    h.store.clear();
    document.body.innerHTML = '';
    capture._resetForTests();

    const form = document.createElement('form');
    const u = document.createElement('input');
    u.type = 'text'; u.name = 'username'; u.value = 'alice';
    const p = document.createElement('input');
    p.type = 'password'; p.name = 'password'; p.value = 'pw';
    form.append(u, p);
    document.body.appendChild(form);

    capture.recordCredentialFocus(u);
    capture.recordPasswordFocus(p);
    capture.trackInput(p);

    for (const l of navListeners.filter((x) => x.type === 'navigate')) l.cb();
    await new Promise<void>((r) => setTimeout(r, 0));

    const { SaveBanner } = await import('../src/content/save-banner');
    expect(SaveBanner.current()?.getCard() ?? null).toBeNull();
    expect(h.store.has(PENDING_KEY)).toBe(false);
  });
});
