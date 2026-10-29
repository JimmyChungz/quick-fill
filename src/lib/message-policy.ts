import type { Profile, Stored } from './types';

/** Validate exact top-level UI identity; capabilities are checked separately below. */
export function requireTrustedPage(sender: chrome.runtime.MessageSender): void {
  if (sender.id !== chrome.runtime.id || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0))
    throw Error('管理消息来源不受信任');
  const url = new URL(sender.url);
  if (url.protocol !== 'chrome-extension:' || url.hostname !== chrome.runtime.id ||
      !['/popup.html', '/options.html', '/diagnostics.html'].includes(url.pathname) ||
      url.username || url.password || url.port || url.hash ||
      (url.search && url.pathname !== '/popup.html'))
    throw Error('管理消息来源不受信任');
}

/** Use Chrome's sender URL, never the origin supplied in a request body. */
export function contentContext(sender: chrome.runtime.MessageSender): { tabId: number; origin: string } {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !Number.isSafeInteger(tabId) || tabId! < 0 || !sender.url)
    throw Error('仅允许顶层页面访问本站数据');
  const url = new URL(sender.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null')
    throw Error('不支持此页面');
  return { tabId: tabId!, origin: url.origin };
}

const PAGE_MESSAGES = new Set([
  'qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile',
  'qf.add_blacklist', 'qf.remove_blacklist', 'qf.clear_all',
  'qf.export', 'qf.export_raw', 'qf.import',
  'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_lock',
  'qf.vault_change', 'qf.vault_export', 'qf.vault_restore',
]);
const POPUP_MESSAGES = new Set([
  'qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile', 'qf.vault_status', 'qf.vault_unlock',
]);

/** Authorize each management capability before reading profiles, vault state or generation. */
export function authorizePageMessage(sender: chrome.runtime.MessageSender, type: string): void {
  requireTrustedPage(sender);
  const path = new URL(sender.url!).pathname;
  if (path === '/options.html' && PAGE_MESSAGES.has(type)) return;
  if (path === '/popup.html' && POPUP_MESSAGES.has(type)) return;
  throw Error('此页面无权执行该管理操作');
}

const CONTENT_MESSAGES = new Set([
  'qf.content_profiles', 'qf.fill_profile', 'qf.capture_begin',
  'qf.pending_put', 'qf.pending_get', 'qf.pending_drop',
  'qf.pending_save', 'qf.pending_blacklist',
]);
const TRACE_MESSAGES = new Set(['qf.trace_status', 'qf.trace_read', 'qf.trace_set', 'qf.trace_event']);

/** Trace requests still require the stricter, dedicated trace authorization. */
export function classifyMessage(type: string): 'page' | 'content' | 'shared' | 'deny' {
  if (PAGE_MESSAGES.has(type)) return 'page';
  if (CONTENT_MESSAGES.has(type)) return 'content';
  if (TRACE_MESSAGES.has(type)) return 'shared';
  return 'deny';
}

/** Suggestion metadata never contains passwords or identity field values. */
export function summarizeForContent(stored: Stored, origin: string): { profiles: Profile[]; blacklist: string[] } {
  const profiles: Profile[] = [];
  for (const profile of stored.profiles) {
    if (profile.kind === 'login') {
      if (profile.url === origin) profiles.push({
        id: profile.id, kind: 'login', url: profile.url, username: profile.username,
        password: '', updatedAt: profile.updatedAt,
        ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
      });
    } else {
      profiles.push({
        id: profile.id, kind: 'identity', label: profile.label, updatedAt: profile.updatedAt,
        ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
        fields: Object.fromEntries(Object.keys(profile.fields).map(key => [key, ''])),
      });
    }
  }
  return { profiles, blacklist: stored.blacklist.includes(origin) ? [origin] : [] };
}
