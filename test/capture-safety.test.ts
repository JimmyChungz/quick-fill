import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
let cap: any, dispose: any;
const drain = () => new Promise((r) => setTimeout(r, 0));
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML =
    '<form id="auth"><input name="username" value="demo"><input id="pw" type="password" value="fake-password"></form><form id="other"><input type="email"></form>';
  installChromeMock();
  cap = await import('../src/content/capture');
  dispose = cap.attachCapture();
});
afterEach(() => {
  if (typeof dispose === 'function') dispose();
  cap.clearPending();
});
it('does not prompt when another form submits', async () => {
  cap.recordPasswordFocus(document.querySelector('#pw'));
  document
    .querySelector('#other')!
    .dispatchEvent(new Event('submit', { bubbles: true }));
  await drain();
  expect(
    (
      await import('../src/content/save-banner')
    ).SaveBanner.current()?.isShown() ?? false,
  ).toBe(false);
});
it('does not treat navigation or pagehide without submit as authentication intent', async () => {
  cap.recordPasswordFocus(document.querySelector('#pw'));
  history.pushState({}, '', '/help');
  window.dispatchEvent(new Event('pagehide'));
  await drain();
  expect(
    (
      await import('../src/content/save-banner')
    ).SaveBanner.current()?.isShown() ?? false,
  ).toBe(false);
});
it('never guesses the first stored account for a password-only candidate', async () => {
  const h = installChromeMock();
  h.store.set('qf.stored.v1', {
    version: 1,
    blacklist: [],
    profiles: [
      {
        id: 'A',
        kind: 'login',
        url: location.origin,
        username: 'a',
        password: 'old',
        updatedAt: 1,
      },
    ],
  });
  document.querySelector<HTMLInputElement>('[name=username]')!.value = '';
  const pw = document.querySelector<HTMLInputElement>('#pw')!;
  pw.value = 'new';
  cap.recordPasswordFocus(pw);
  document.querySelector('#auth')!.dispatchEvent(new Event('submit', { bubbles:true }));
  await drain();
  const { SaveBanner } = await import('../src/content/save-banner');
  expect(SaveBanner.current()?.getCard()?.textContent).toContain('保存登录');
  expect(SaveBanner.current()?.getCard()?.textContent).not.toContain('更新已保存');
});
it('keeps banner and allows retry when save receives qf.error', async () => {
  const { SaveBanner } = await import('../src/content/save-banner');
  const b = new SaveBanner();
  (chrome.runtime as any).sendMessage = (_m: any, cb: any) =>
    cb({ type: 'qf.error', message: 'simulated failure' });
  b.show({
    origin: location.origin,
    username: 'demo',
    password: 'fake',
    operationId: 'A',
    generation: '0',
  } as any);
  await b.save();
  expect(b.isShown()).toBe(true);
  expect(b.getCard()?.textContent).toContain('simulated failure');
  b.hide();
});
it('dispatches pending persistence synchronously before navigation can destroy the source', () => {
  const messages: any[] = [];
  (chrome.runtime as any).sendMessage = (m: any, _cb: any) => {
    messages.push(m);
  };
  cap.recordPasswordFocus(document.querySelector('#pw'));
  document
    .querySelector('#auth')!
    .dispatchEvent(new Event('submit', { bubbles: true }));
  expect(messages.some((m) => m.type === 'qf.pending_put')).toBe(true);
});
it('retains last scoped typed value when a controlled form clears DOM before submit', async () => {
  const messages: any[] = [];
  const old = chrome.runtime.sendMessage;
  (chrome.runtime as any).sendMessage = (m: any, cb: any) => {
    messages.push(m);
    return (old as any)(m, cb);
  };
  const pw = document.querySelector<HTMLInputElement>('#pw')!;
  cap.recordPasswordFocus(pw);
  cap.trackInput(pw);
  pw.value = '';
  document
    .querySelector('#auth')!
    .dispatchEvent(new Event('submit', { bubbles: true }));
  await drain();
  expect(
    messages.find((m) => m.type === 'qf.pending_put')?.candidate.password,
  ).toBe('fake-password');
});
it('does not replay a saved candidate onto a registration form', async () => {
  const h = installChromeMock();
  h.store.set('qf.pending.v2', {
    id: 'A',
    origin: location.origin,
    username: 'demo',
    password: 'fake',
    createdAt: Date.now(),
  });
  document.querySelector('#pw')!.setAttribute('autocomplete', 'new-password');
  expect(await cap.flushPendingBanner()).toBe('skipped');
  expect(
    (
      await import('../src/content/save-banner')
    ).SaveBanner.current()?.isShown() ?? false,
  ).toBe(false);
});
it('waits for submit for native input-submit buttons whose form may be invalid', () => {
  const messages: any[] = [];
  (chrome.runtime as any).sendMessage = (m: any, _cb: any) => messages.push(m);
  const form = document.querySelector<HTMLFormElement>('#auth')!;
  form.insertAdjacentHTML(
    'beforeend',
    '<input type="email" required value="invalid"><input id="submit-login" type="submit" value="登录">',
  );
  cap.recordPasswordFocus(document.querySelector('#pw'));
  document.querySelector<HTMLInputElement>('#submit-login')!.click();
  expect(messages.some((m) => m.type === 'qf.pending_put')).toBe(false);
});
