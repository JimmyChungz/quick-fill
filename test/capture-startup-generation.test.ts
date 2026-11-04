import { afterEach, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';

let detach: (() => void) | undefined;
let reset: (() => void) | undefined;

afterEach(() => {
  detach?.();
  reset?.();
  vi.restoreAllMocks();
});

it.each(['available', 'missing', 'error', 'dismissed', 'cleared'])('settles an older SPA replay with %s current candidate without unbounded retry', async outcome => {
  vi.resetModules();
  document.body.innerHTML = '<form><input name="username" value="synthetic-spa"><input type="password" value="Synthetic-only-42!"></form>';
  installChromeMock();
  let finishPut: ((response: unknown) => void) | undefined;
  let finishReplay: ((response: unknown) => void) | undefined;
  let operationId = '';
  let persisted: unknown = null;
  let replayReads = 0;
  vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(((message: { type: string; id?: string }, reply: (response: unknown) => void) => {
    if (message.type === 'qf.capture_begin') reply({ type: 'qf.ok', generation: '0' });
    else if (message.type === 'qf.pending_put') { operationId = message.id!; finishPut = reply; }
    else if (message.type === 'qf.pending_get') {
      if (++replayReads === 1) finishReplay = reply;
      else reply(outcome === 'error' ? { type: 'qf.error', message: 'synthetic read failure' }
        : { type: 'qf.pending', pending: persisted, generation: '0' });
    }
    else if (message.type === 'qf.pending_drop') reply({ type: 'qf.ok', generation: '0' });
  }) as typeof chrome.runtime.sendMessage);
  const capture = await import('../src/content/capture');
  const { SaveBanner } = await import('../src/content/save-banner');
  detach = capture.attachCapture();
  reset = capture._resetForTests;
  capture.recordPasswordFocus(document.querySelector<HTMLInputElement>('input[type=password]')!);
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  // A same-document navigation starts replay before pending_put is acknowledged.
  const olderReplay = capture.flushPendingBanner();
  expect(finishPut).toBeTypeOf('function');
  expect(finishReplay).toBeTypeOf('function');
  const pending = { id: operationId, origin: location.origin, username: 'synthetic-spa', password: 'Synthetic-only-42!', generation: '0', createdAt: Date.now(), tabId: 7 };
  persisted = outcome === 'missing' ? null : pending;
  finishPut!({ type: 'qf.pending', pending, generation: '0' });
  await Promise.resolve(); await Promise.resolve();
  const banner = SaveBanner.current()!;
  expect(banner.isShown()).toBe(true);
  // A framework replaces body and sibling extension hosts while replay waits.
  document.documentElement.replaceChildren(document.head, document.createElement('body'));
  await Promise.resolve(); await Promise.resolve();
  expect(banner.hasDetachedHost()).toBe(true);
  if (outcome === 'dismissed') await banner.dismiss();
  if (outcome === 'cleared') capture.clearPending(); // Lock/replacement notifications use this path.
  finishReplay!({ type: 'qf.pending', pending, generation: '0' });
  await olderReplay;
  await Promise.resolve(); await Promise.resolve();
  expect(banner.isShown()).toBe(outcome === 'available');
  expect(replayReads).toBe(['dismissed', 'cleared'].includes(outcome) ? 1 : 2);
});
