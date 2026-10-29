import { beforeEach, describe, expect, it, vi } from 'vitest';

type TraceModule = typeof import('../src/lib/capture-trace');
let trace: TraceModule;
const operationId = '7c2c64ee-650c-49de-8f83-19307c671ce9';

beforeEach(async () => {
  vi.resetModules();
  trace = await import('../src/lib/capture-trace');
});

describe('capture trace safety', () => {
  it('is disabled by default and records nothing until explicitly enabled', () => {
    trace.captureTrace('content_injected');
    expect(trace.readCaptureTrace()).toEqual([]);
    trace.setCaptureTraceEnabled(true);
    trace.captureTrace('content_injected');
    expect(trace.readCaptureTrace()).toEqual([{ event: 'content_injected', timestamp: expect.any(Number) }]);
  });

  it('whitelists safe details and strips usernames, passwords, URL, request bodies and raw errors', () => {
    const details = {
      operationId, reason: 'storage-error', hasUsername: true, hasPassword: false, fieldCount: 2,
      username: 'private-user', password: 'private-password', url: 'https://private.example/path?token=secret',
      requestBody: { password: 'private-password' }, rawError: new Error('private-error'), timestamp: 0,
    };
    const safe = trace.sanitizeCaptureTrace('pending_put_error', details);
    expect(safe).toEqual({ event: 'pending_put_error', timestamp: expect.any(Number), operationId,
      reason: 'storage-error', hasUsername: true, hasPassword: false, fieldCount: 2 });
    expect(safe!.timestamp).toBeGreaterThan(0);
    expect(JSON.stringify(safe)).not.toMatch(/private-|private\.example|secret/);
  });

  it.each(['save_click', 'pending_save_sent', 'pending_save_ack', 'pending_save_error'])('accepts finite save state %s without raw payload or error details', event => {
    expect(trace.sanitizeCaptureTrace(event, {
      operationId, reason: 'storage-error', username: 'synthetic-private-user', password: 'synthetic-private-password',
      url: 'https://synthetic-private.example', error: 'synthetic-private-error',
    })).toEqual({ event, timestamp: expect.any(Number), operationId, reason: 'storage-error' });
  });

  it('rejects arbitrary event names and reason values at runtime', () => {
    expect(trace.sanitizeCaptureTrace('private-password', { reason: 'none' })).toBeNull();
    expect(trace.sanitizeCaptureTrace({}, {})).toBeNull();
    expect(trace.sanitizeCaptureTrace('prompt_skipped', { reason: 'private-error message', operationId })).toEqual({
      timestamp: expect.any(Number), event: 'prompt_skipped', operationId,
    });
    trace.setCaptureTraceEnabled(true);
    trace.captureTrace('private-password' as never);
    expect(trace.readCaptureTrace()).toEqual([]);
  });

  it.each(['https://private.example', 'user@example.com', 'line\nprivate-error', 'fixture\n', '', 'x'.repeat(129)])('drops unsafe operation ID %j', id => {
    expect(trace.sanitizeCaptureTrace('candidate_present', { operationId: id })).toEqual({
      event: 'candidate_present', timestamp: expect.any(Number),
    });
  });

  it('accepts the same bounded operation IDs as the service worker', () => {
    expect(trace.sanitizeCaptureTrace('capture_begin_sent', { operationId: 'fixture-123' })?.operationId).toBe('fixture-123');
    expect(trace.sanitizeCaptureTrace('capture_begin_sent', { operationId: 'A'.repeat(128) })?.operationId).toHaveLength(128);
  });

  it.each([null, [], 'private-password', 9, true].map(value => [value]))('tolerates malformed details %j', details => {
    expect(trace.sanitizeCaptureTrace('focus_detected', details)).toEqual({ event: 'focus_detected', timestamp: expect.any(Number) });
  });

  it('ignores inherited data and does not invoke details getters', () => {
    const details = Object.create({ hasPassword: true });
    const getter = vi.fn(() => { throw new Error('private-getter-error'); });
    Object.defineProperty(details, 'operationId', { get: getter });
    Object.defineProperty(details, 'password', { get: getter });
    expect(trace.sanitizeCaptureTrace('candidate_present', details)).toEqual({ event: 'candidate_present', timestamp: expect.any(Number) });
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not coerce truthy data or invalid field counts', () => {
    for (const fieldCount of [NaN, Infinity, -1, 0.5, '2', null]) {
      expect(trace.sanitizeCaptureTrace('field_classified', { hasUsername: 'true', hasPassword: 1, fieldCount })).toEqual({
        event: 'field_classified', timestamp: expect.any(Number),
      });
    }
    expect(trace.sanitizeCaptureTrace('field_classified', { hasUsername: false, hasPassword: true, fieldCount: 0 })).toMatchObject({ hasUsername: false, hasPassword: true, fieldCount: 0 });
    expect(trace.sanitizeCaptureTrace('field_classified', { fieldCount: 10_000 })?.fieldCount).toBe(1000);
  });

  it('keeps only the latest 100 entries in order and returns independent copies', () => {
    trace.setCaptureTraceEnabled(true);
    for (let i = 0; i < 105; i++) trace.captureTrace('candidate_present', { operationId: `operation-${i}`, fieldCount: i });
    const entries = trace.readCaptureTrace();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.operationId).toBe('operation-5');
    expect(entries[99]!.operationId).toBe('operation-104');
    entries[0]!.operationId = 'altered';
    entries.pop();
    expect(trace.readCaptureTrace()).toHaveLength(100);
    expect(trace.readCaptureTrace()[0]!.operationId).toBe('operation-5');
  });

  it('copies details on capture so later input mutations cannot alter the trace', () => {
    trace.setCaptureTraceEnabled(true);
    const details = { operationId, hasPassword: true };
    trace.captureTrace('pending_put_sent', details);
    details.operationId = 'changed';
    details.hasPassword = false;
    expect(trace.readCaptureTrace()[0]).toMatchObject({ operationId, hasPassword: true });
  });

  it('clears records on disabling and does not restore them after reenabling', () => {
    trace.setCaptureTraceEnabled(true);
    trace.captureTrace('banner_shown');
    trace.setCaptureTraceEnabled(false);
    trace.captureTrace('banner_hidden');
    expect(trace.readCaptureTrace()).toEqual([]);
    trace.setCaptureTraceEnabled(true);
    expect(trace.readCaptureTrace()).toEqual([]);
  });

  it('performs no storage, network or console output', () => {
    const storageWrite = vi.fn();
    const network = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { set: storageWrite }, session: { set: storageWrite } } });
    vi.stubGlobal('fetch', network);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const debug = vi.spyOn(console, 'debug');
    const error = vi.spyOn(console, 'error');
    trace.setCaptureTraceEnabled(true);
    trace.captureTrace('capture_begin_error', { reason: 'storage-error', operationId });
    trace.readCaptureTrace();
    trace.setCaptureTraceEnabled(false);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    for (const output of [log, warn, debug, error]) expect(output).not.toHaveBeenCalled();
  });
});
