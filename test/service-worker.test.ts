// Credential setup is exercised with the real vault in credential-policy.test.ts and browser suites.
vi.mock('../src/background/credential-policy', () => ({requireEncryptedCredentials: async () => {}}));
// First tests for the service worker.
//
// It had ZERO coverage, which is exactly how a duplicated `case 'qf.export'`
// (dead code, flagged by esbuild as `[duplicate-case]`) shipped in a build that
// everyone called "green". The build now fails on warnings; this file makes
// `npm test` notice as well.
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installChromeMock, loginProfile, STORE_KEY, PAGE_SENDER, type Harness } from './helpers/chrome-mock';
import type { Stored } from '../src/lib/types';

const HERE = dirname(fileURLToPath(import.meta.url));

type SwListener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => void;

let h: Harness;
const swListeners: SwListener[] = [];

beforeAll(async () => {
  h = installChromeMock();
  const runtime = (globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome.runtime;
  // capture the SW's registration instead of ignoring it
  runtime.onMessage = { addListener(fn: SwListener) { swListeners.push(fn); } };
  runtime.onInstalled = { addListener() { /* noop */ } };
  await import('../src/background/service-worker');
});

const call = (msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { swListeners[0]!({generation:'0', ...(msg as object)}, PAGE_SENDER, resolve as (r: unknown) => void); });

const empty: Stored = { version: 1, profiles: [], blacklist: [] };

beforeEach(async () => {
  h.store.clear();
  h.setStored(empty);
  await h.pump();
});

describe('service worker — message handling', () => {
  it('answers qf.get_profiles with the stored list', async () => {
    h.setStored({ ...empty, profiles: [loginProfile()] });
    await h.pump();
    const res = await call({ type: 'qf.get_profiles' });
    expect(res.type).toBe('qf.profiles');
    expect((res.profiles as unknown[]).length).toBe(1);
  });

  it('persists an upsert and echoes the new list', async () => {
    const res = await call({ type: 'qf.update_profile', profile: loginProfile({ id: 'new-one' }) });
    expect(res.type).toBe('qf.profiles');
    expect((res.profiles as Array<{ id: string }>).map((p) => p.id)).toEqual(['new-one']);
  });

  it('deletes by id', async () => {
    await call({ type: 'qf.update_profile', profile: loginProfile({ id: 'a' }) });
    const res = await call({ type: 'qf.delete_profile', id: 'a' });
    expect(res.profiles).toEqual([]);
  });

  it('records a blacklisted origin', async () => {
    await call({ type: 'qf.add_blacklist', origin: 'https://blocked.example/login' });
    const stored = h.store.get(STORE_KEY) as Stored;
    expect(stored.blacklist).toEqual(['https://blocked.example']);
  });

  it('answers qf.export with an export payload', async () => {
    await call({ type: 'qf.update_profile', profile: loginProfile() });
    const res = await call({ type: 'qf.export' });
    expect(res.version).toBe(1);
    expect(typeof res.exportedAt).toBe('number');
    expect((res.profiles as unknown[]).length).toBe(1);
  });

  it('imports rows and reports how many were rejected', async () => {
    const res = await call({
      type: 'qf.import',
      payload: { version: 1, exportedAt: 0, profiles: [loginProfile({ id: 'ok' }), { id: 'bad', kind: 'identity' }] },
    });
    expect(res.imported).toBe(1);
    expect(res.rejected).toBe(1);
  });

  it('answers an unknown message with qf.error instead of undefined', async () => {
    const res = await call({ type: 'qf.definitely.not.a.message' });
    expect(res.type).toBe('qf.error');
  });
});

describe('service worker — source hygiene', () => {
  it('declares each case label only once', () => {
    // Guards the exact regression that shipped: two `case 'qf.export'` blocks,
    // the second unreachable. TypeScript accepts it, esbuild only warns, and it
    // was invisible to the test suite until this file existed.
    const src = readFileSync(join(HERE, '..', 'src', 'background', 'service-worker.ts'), 'utf-8');
    const labels = [...src.matchAll(/case '([^']+)':/g)].map((m) => m[1]!);
    const duplicates = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(duplicates).toEqual([]);
  });
});
