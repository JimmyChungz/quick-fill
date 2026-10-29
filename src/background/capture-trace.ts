import { CAPTURE_TRACE_LIMIT, sanitizeCaptureTrace, type CaptureTraceEntry } from '../lib/capture-trace';

export const TRACE_ENABLED_KEY = 'qf.capture-trace-enabled';
export const TRACE_EVENTS_KEY = 'qf.capture-trace-events';
export const TRACE_TTL_MS = 10 * 60 * 1000;
type SessionTraceEntry = CaptureTraceEntry & { tabId?: number };
type TraceMessage = { type: string; event?: unknown; details?: unknown; enabled?: unknown };

function trustedUI(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id &&
      url.pathname === '/diagnostics.html' && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}
function trustedContent(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0 || !sender.url) return false;
  try { return ['http:', 'https:'].includes(new URL(sender.url).protocol); }
  catch { return false; }
}
function safeEvents(raw: unknown, now: number): SessionTraceEntry[] {
  if (!Array.isArray(raw)) return [];
  const events: SessionTraceEntry[] = [];
  for (const row of raw.slice(-CAPTURE_TRACE_LIMIT)) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > now || now - row.timestamp >= TRACE_TTL_MS) continue;
    const safe: SessionTraceEntry | null = sanitizeCaptureTrace(row.event, row);
    if (!safe) continue;
    safe.timestamp = row.timestamp;
    if (Number.isSafeInteger(row.tabId) && row.tabId >= 0) safe.tabId = row.tabId;
    events.push(safe);
  }
  return events;
}
async function readState(): Promise<{ enabled: boolean; events: SessionTraceEntry[] }> {
  const raw = await chrome.storage.session.get([TRACE_ENABLED_KEY, TRACE_EVENTS_KEY]);
  const flag: unknown = raw[TRACE_ENABLED_KEY];
  const now = Date.now();
  const enabled = !!flag && typeof flag === 'object' && 'enabled' in flag && flag.enabled === true &&
    'expiresAt' in flag && typeof flag.expiresAt === 'number' && Number.isSafeInteger(flag.expiresAt) &&
    flag.expiresAt > now && flag.expiresAt <= now + TRACE_TTL_MS;
  if (!enabled) {
    const cleared = !!flag && typeof flag === 'object' && 'enabled' in flag && flag.enabled === false && 'expiresAt' in flag && flag.expiresAt === 0;
    const rawEvents: unknown = raw[TRACE_EVENTS_KEY];
    const hasEvents = Array.isArray(rawEvents) ? rawEvents.length > 0 : rawEvents !== undefined;
    if ((!cleared && flag !== undefined) || hasEvents) {
      await chrome.storage.session.set({ [TRACE_ENABLED_KEY]: { enabled: false, expiresAt: 0 }, [TRACE_EVENTS_KEY]: [] });
    }
    return { enabled: false, events: [] };
  }
  return { enabled: true, events: safeEvents(raw[TRACE_EVENTS_KEY], now) };
}

/** The service worker caller serializes this read-modify-write operation. */
export async function handleCaptureTrace(msg: TraceMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'qf.trace_set': {
      if (!trustedUI(sender)) throw new Error('诊断设置来源不受信任');
      if (typeof msg.enabled !== 'boolean') throw new Error('诊断开关必须是布尔值');
      await chrome.storage.session.set({
        [TRACE_ENABLED_KEY]: { enabled: msg.enabled, expiresAt: msg.enabled ? Date.now() + TRACE_TTL_MS : 0 },
        [TRACE_EVENTS_KEY]: [],
      });
      return { type: 'qf.trace_result', enabled: msg.enabled };
    }
    case 'qf.trace_read': {
      if (!trustedUI(sender)) throw new Error('诊断读取来源不受信任');
      return { type: 'qf.trace_result', ...await readState() };
    }
    case 'qf.trace_status': {
      if (!trustedUI(sender) && !trustedContent(sender)) throw new Error('诊断状态来源不受信任');
      return { type: 'qf.trace_status', enabled: (await readState()).enabled };
    }
    case 'qf.trace_event': {
      if (!trustedContent(sender)) throw new Error('诊断事件来源不受信任');
      const entry: SessionTraceEntry | null = sanitizeCaptureTrace(msg.event, msg.details);
      if (!entry) throw new Error('诊断事件类型无效');
      const state = await readState();
      if (!state.enabled) return { type: 'qf.trace_result', enabled: false };
      entry.tabId = sender.tab!.id!;
      const events = [...state.events, entry].slice(-CAPTURE_TRACE_LIMIT);
      await chrome.storage.session.set({ [TRACE_EVENTS_KEY]: events });
      return { type: 'qf.trace_result', enabled: true };
    }
    default: throw new Error('未知诊断消息');
  }
}
