import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';

let banner: import('../src/content/save-banner').SaveBanner;
let messages: Array<Record<string, any>>;
let reply: (response: unknown) => void;
let prepareError = false;
const operationId = 'synthetic-save-operation';
const saveEvents = () => messages.filter(message => message.type === 'qf.trace_event' &&
  ['save_click', 'pending_save_sent', 'pending_save_ack', 'pending_save_error'].includes(message.event));

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  messages = [];
  prepareError = false;
  chrome.runtime.sendMessage = ((message: Record<string, any>, callback: (response: unknown) => void) => {
    messages.push(message);
    if (message.type === 'qf.trace_status') callback({ type: 'qf.trace_status', enabled: true });
    else if (message.type === 'qf.trace_event') callback({ type: 'qf.trace_result', enabled: true });
    else if (message.type === 'qf.pending_put') callback(prepareError ? { type: 'qf.error', message: 'synthetic-private-error' } : { type: 'qf.pending', generation: '0' });
    else if (message.type === 'qf.pending_save') reply = callback;
    else callback({ type: 'qf.ok', generation: '0' });
  }) as typeof chrome.runtime.sendMessage;
  const { initializeCaptureTrace } = await import('../src/content/trace-client');
  await initializeCaptureTrace();
  const { SaveBanner } = await import('../src/content/save-banner');
  banner = new SaveBanner();
  banner.show({ origin: 'https://synthetic-private.example', username: 'synthetic-private-user', password: 'synthetic-private-password', operationId, generation: '0' });
});
afterEach(() => banner.hide());

it('records save click and send before the response, then ACK only after qf.ok', async () => {
  const saved = banner.save();
  expect(saveEvents().map(message => message.event)).toEqual(['save_click', 'pending_save_sent']);
  expect(banner.isShown()).toBe(true);
  reply({ type: 'qf.ok', generation: '0' });
  await saved;
  expect(saveEvents().map(message => message.event)).toEqual(['save_click', 'pending_save_sent', 'pending_save_ack']);
  expect(banner.isShown()).toBe(false);
  expect(messages.findIndex(message => message.event === 'pending_save_sent')).toBeLessThan(messages.findIndex(message => message.type === 'qf.pending_save'));
  expect(JSON.stringify(saveEvents())).not.toMatch(/synthetic-private|username|password|origin/);
  for (const message of saveEvents()) expect(message.details.operationId).toBe(operationId);
});

it('records a finite error and retries a lost ACK with the same operation ID', async () => {
  const failed = banner.save();
  Object.assign(chrome.runtime, { lastError: { message: 'synthetic-private-lost-response' } });
  reply(undefined);
  await failed;
  Object.assign(chrome.runtime, { lastError: undefined });
  expect(banner.isShown()).toBe(true);
  expect(saveEvents().map(message => message.event)).toEqual(['save_click', 'pending_save_sent', 'pending_save_error']);
  expect(saveEvents().at(-1)!.details.reason).toBe('storage-error');
  const retried = banner.save();
  reply({ type: 'qf.ok', generation: '0' });
  await retried;
  expect(messages.filter(message => message.type === 'qf.pending_save').map(message => message.id)).toEqual([operationId, operationId]);
  expect(saveEvents().filter(message => message.event === 'pending_save_ack')).toHaveLength(1);
  expect(JSON.stringify(saveEvents())).not.toContain('synthetic-private');
});

it('does not acknowledge an unexpected successful response type', async () => {
  const saved = banner.save();
  reply({ type: 'qf.profiles', profiles: [] });
  await saved;
  expect(saveEvents().map(message => message.event)).toEqual(['save_click', 'pending_save_sent', 'pending_save_error']);
  expect(banner.isShown()).toBe(true);
});

it('does not report a save send when preparing pending persistence failed', async () => {
  banner.show({ origin: 'https://synthetic-private.example', username: 'synthetic-private-user', password: 'synthetic-private-password', operationId, generation: '0', needsPersist: true });
  prepareError = true;
  await banner.save();
  expect(saveEvents().map(message => message.event)).toEqual(['save_click', 'pending_save_error']);
  expect(messages.filter(message => message.type === 'qf.pending_save')).toEqual([]);
  expect(banner.isShown()).toBe(true);
});

it('does not emit save events for dismiss or blacklist actions', async () => {
  await banner.dismiss();
  banner.show({ origin: 'https://synthetic-private.example', username: 'synthetic-private-user', password: 'synthetic-private-password', operationId, generation: '0' });
  await banner.blacklist();
  expect(saveEvents()).toEqual([]);
});

it('emits no trace events when the user has not enabled diagnostics', async () => {
  chrome.runtime.sendMessage = ((message: Record<string, any>, callback: (response: unknown) => void) => {
    messages.push(message);
    callback(message.type === 'qf.trace_status' ? { type: 'qf.trace_status', enabled: false } : { type: 'qf.ok', generation: '0' });
  }) as typeof chrome.runtime.sendMessage;
  const { initializeCaptureTrace } = await import('../src/content/trace-client');
  await initializeCaptureTrace();
  messages.length = 0;
  await banner.save();
  expect(banner.isShown()).toBe(false);
  expect(messages.map(message => message.type)).toEqual(['qf.pending_save']);
});
