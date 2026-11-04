import { beforeEach, describe, expect, it, vi } from 'vitest';

type TraceModule = typeof import('../src/background/capture-trace');
let trace: TraceModule;
const ENABLED = 'qf.capture-trace-enabled';
const EVENTS = 'qf.capture-trace-events';
const extensionId = 'neilinbkkjgcnflgamepebchiapfcibm';
const ui = { id: extensionId, url: `chrome-extension://${extensionId}/diagnostics.html` };
const content = { id: extensionId, url: 'https://private.example/login?token=private', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
let store: Map<string, unknown>;
let writes: ReturnType<typeof vi.fn>;
const invoke = (msg: Parameters<TraceModule['handleCaptureTrace']>[0], sender: chrome.runtime.MessageSender = ui) => trace.handleCaptureTrace(msg, sender) as Promise<{ enabled: boolean; events?: Record<string, unknown>[] }>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  store = new Map();
  writes = vi.fn(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) store.set(key, structuredClone(value));
  });
  vi.stubGlobal('chrome', {
    runtime: { id: extensionId },
    storage: { session: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, structuredClone(store.get(key))]))),
      set: writes,
    } },
  });
  trace = await import('../src/background/capture-trace');
});

describe('background capture trace boundary', () => {
  it('is off by default and ignores safe content events while off', async () => {
    expect(await invoke({ type: 'qf.trace_status' }, content)).toMatchObject({ enabled: false });
    expect(await invoke({ type: 'qf.trace_event', event: 'focus_detected', details: { hasPassword: true } }, content)).toMatchObject({ enabled: false });
    expect(await invoke({ type: 'qf.trace_read' })).toMatchObject({ enabled: false, events: [] });
    expect(writes).not.toHaveBeenCalled();
  });

  it('requires an explicit boolean toggle and clears the prior ring on every toggle', async () => {
    await expect(invoke({ type: 'qf.trace_set', enabled: 'true' })).rejects.toThrow();
    await invoke({ type: 'qf.trace_set', enabled: true });
    expect((store.get(ENABLED) as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
    await invoke({ type: 'qf.trace_event', event: 'banner_shown' }, content);
    expect((await invoke({ type: 'qf.trace_read' })).events).toHaveLength(1);
    await invoke({ type: 'qf.trace_set', enabled: true });
    expect((await invoke({ type: 'qf.trace_read' })).events).toEqual([]);
    await invoke({ type: 'qf.trace_set', enabled: false });
    expect(await invoke({ type: 'qf.trace_read' })).toMatchObject({ enabled: false, events: [] });
  });

  it.each([
    content,
    { ...ui, id: 'external-extension' },
    { ...ui, url: `chrome-extension://${extensionId}/options.html` },
    { ...ui, url: `chrome-extension://${extensionId}/nested/diagnostics.html` },
    { ...ui, url: `https://${extensionId}/diagnostics.html` },
    { ...ui, url: `chrome-extension://${extensionId}/diagnostics.html?extra=1` },
    { ...ui, url: `chrome-extension://user@${extensionId}/diagnostics.html` },
    { ...ui, url: `chrome-extension://${extensionId}:1234/diagnostics.html` },
    { ...ui, url: 'invalid' },
    {},
  ])('rejects non-diagnostic UI sender for controls %#', async sender => {
    await expect(invoke({ type: 'qf.trace_set', enabled: true }, sender)).rejects.toThrow();
    await expect(invoke({ type: 'qf.trace_read' }, sender)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    { ...content, id: 'external-extension' },
    { ...content, frameId: 1 },
    { ...content, frameId: undefined },
    { ...content, url: 'chrome://extensions/' },
    { ...content, url: 'file:///private/path' },
    { ...content, url: 'invalid' },
    { ...content, tab: { id: -1 } },
    ui,
  ])('rejects invalid event senders %#', async sender => {
    await invoke({ type: 'qf.trace_set', enabled: true });
    await expect(invoke({ type: 'qf.trace_event', event: 'focus_detected' }, sender as chrome.runtime.MessageSender)).rejects.toThrow();
    expect((await invoke({ type: 'qf.trace_read' })).events).toEqual([]);
  });

  it('allows the exact privileged diagnostics URL when Chrome includes extension-tab metadata', async () => {
    const extensionTab = { ...ui, tab: { id: 8 }, frameId: 0 } as chrome.runtime.MessageSender;
    expect(await invoke({ type: 'qf.trace_set', enabled: true }, extensionTab)).toMatchObject({ enabled: true });
    expect(await invoke({ type: 'qf.trace_read' }, extensionTab)).toMatchObject({ enabled: true, events: [] });
    await expect(invoke({ type: 'qf.trace_set', enabled: false }, { ...extensionTab, url: 'https://private.example/diagnostics.html' })).rejects.toThrow();
    await expect(invoke({ type: 'qf.trace_read' }, { ...extensionTab, frameId: 1 })).rejects.toThrow();
  });

  it('keeps status and read operations free of writes once explicitly disabled', async () => {
    await invoke({ type: 'qf.trace_set', enabled: false });
    writes.mockClear();
    await invoke({ type: 'qf.trace_status' }, content);
    await invoke({ type: 'qf.trace_read' });
    await invoke({ type: 'qf.trace_event', event: 'focus_detected' }, content);
    expect(writes).not.toHaveBeenCalled();
  });

  it('sanitizes hostile event details and stores only a numeric source tab ID', async () => {
    await invoke({ type: 'qf.trace_set', enabled: true });
    await invoke({ type: 'qf.trace_event', event: 'candidate_present', details: {
      operationId: 'fixture-1', reason: 'none', hasUsername: false, hasPassword: true, fieldCount: 2,
      username: 'private-user', password: 'private-password', url: 'https://private.example', error: 'private-error', tabId: 999,
    } }, content);
    const result = await invoke({ type: 'qf.trace_read' });
    expect(result.events).toEqual([{ timestamp: expect.any(Number), event: 'candidate_present', operationId: 'fixture-1',
      reason: 'none', hasUsername: false, hasPassword: true, fieldCount: 2, tabId: 7 }]);
    expect(JSON.stringify([...store])).not.toMatch(/private|token|999/);
  });

  it('rejects arbitrary event names without storing them', async () => {
    await invoke({ type: 'qf.trace_set', enabled: true });
    await expect(invoke({ type: 'qf.trace_event', event: 'private-error', details: { reason: 'private-error' } }, content)).rejects.toThrow();
    expect((await invoke({ type: 'qf.trace_read' })).events).toEqual([]);
  });

  it('bounds the session ring at 100 entries', async () => {
    await invoke({ type: 'qf.trace_set', enabled: true });
    for (let i = 0; i < 105; i++) await invoke({ type: 'qf.trace_event', event: 'pending_put_ack', details: { operationId: `operation-${i}` } }, content);
    const result = await invoke({ type: 'qf.trace_read' });
    expect(result.events).toHaveLength(100);
    expect(result.events![0]!.operationId).toBe('operation-5');
    expect(result.events![99]!.operationId).toBe('operation-104');
  });

  it('automatically disables and clears expired traces after ten minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await invoke({ type: 'qf.trace_set', enabled: true });
    await invoke({ type: 'qf.trace_event', event: 'banner_shown' }, content);
    now.mockReturnValue(1_600_000);
    expect(await invoke({ type: 'qf.trace_status' }, content)).toMatchObject({ enabled: false });
    expect(store.get(EVENTS)).toEqual([]);
    expect(await invoke({ type: 'qf.trace_read' })).toMatchObject({ enabled: false, events: [] });
    now.mockRestore();
  });

  it('redacts malformed preexisting session events on read and does not trust persisted extra fields', async () => {
    const now = Date.now();
    store.set(ENABLED, { enabled: true, expiresAt: now + 600_000 });
    store.set(EVENTS, [
      { timestamp: now, event: 'banner_shown', tabId: 7, password: 'private-password' },
      { timestamp: now, event: 'private-error' },
      { timestamp: now - 600_001, event: 'banner_hidden' },
      { timestamp: now, event: 'candidate_present', operationId: 'https://private.example' },
    ]);
    expect((await invoke({ type: 'qf.trace_read' })).events).toEqual([
      { timestamp: now, event: 'banner_shown', tabId: 7 },
      { timestamp: now, event: 'candidate_present' },
    ]);
  });

  it('does not treat a missing expiry or a truthy flag as enabled', async () => {
    for (const invalid of [true, 'true', { enabled: true }, { enabled: 'true', expiresAt: Date.now() + 600_000 }]) {
      store.set(ENABLED, invalid);
      expect(await invoke({ type: 'qf.trace_status' }, content)).toMatchObject({ enabled: false });
    }
  });

  it('rejects unknown messages and hostile status senders', async () => {
    await expect(invoke({ type: 'qf.other' })).rejects.toThrow();
    await expect(invoke({ type: 'qf.trace_status' }, { ...content, id: 'external-extension' })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });

  it('propagates session write failure without a false acknowledgement', async () => {
    writes.mockRejectedValueOnce(new Error('session write failed'));
    await expect(invoke({ type: 'qf.trace_set', enabled: true })).rejects.toThrow('session write failed');
  });
});
