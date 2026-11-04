import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizePageMessage, classifyMessage, contentContext, requireTrustedPage, summarizeForContent } from '../src/lib/message-policy';
import type { Stored } from '../src/lib/types';

const extensionId = 'neilinbkkjgcnflgamepebchiapfcibm';
const page = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
const content = { id: extensionId, url: 'https://site.example/login?synthetic-token=1', frameId: 0, tab: { id: 7 } } as chrome.runtime.MessageSender;

beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: extensionId } }));

describe('privileged page sender boundary', () => {
  it.each(['popup.html', 'popup.html?editor=1&profile=L1', 'options.html', 'diagnostics.html'])('accepts own exact extension page %s with extension-tab metadata', route => {
    expect(() => requireTrustedPage({ ...page, url: `chrome-extension://${extensionId}/${route}`, tab: { id: 9 }, frameId: 0 } as chrome.runtime.MessageSender)).not.toThrow();
  });

  it.each([
    {}, content, { ...page, id: undefined }, { ...page, id: 'external-extension' },
    { ...page, frameId: 1 }, { ...page, frameId: -1 },
    { ...page, url: `https://${extensionId}/popup.html` },
    { ...page, url: `chrome-extension://external-extension/popup.html` },
    { ...page, url: `chrome-extension://${extensionId}/nested/popup.html` },
    { ...page, url: `chrome-extension://${extensionId}/popup.html/` },
    { ...page, url: `chrome-extension://${extensionId}/%70opup.html` },
    { ...page, url: `chrome-extension://user@${extensionId}/popup.html` },
    { ...page, url: `chrome-extension://${extensionId}:1234/popup.html` },
    { ...page, url: `chrome-extension://${extensionId}/popup.html#editor` },
    { ...page, url: `chrome-extension://${extensionId}/options.html?editor=1` },
    { ...page, url: 'invalid' },
  ])('rejects a forged or non-page sender %#', sender => {
    expect(() => requireTrustedPage(sender as chrome.runtime.MessageSender)).toThrow();
  });
});

describe('page message capabilities', () => {
  const management = ['qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile',
    'qf.add_blacklist', 'qf.remove_blacklist', 'qf.clear_all', 'qf.export', 'qf.export_raw', 'qf.import',
    'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_lock', 'qf.vault_change', 'qf.vault_export', 'qf.vault_restore'];
  const popupAllowed = ['qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile', 'qf.vault_status', 'qf.vault_unlock'];
  it.each(management)('allows options management but denies diagnostics %s', type => {
    expect(() => authorizePageMessage({ ...page, url: `chrome-extension://${extensionId}/options.html` }, type)).not.toThrow();
    expect(() => authorizePageMessage({ ...page, url: `chrome-extension://${extensionId}/diagnostics.html` }, type)).toThrow();
    expect(() => authorizePageMessage({ ...page, url: `chrome-extension://${extensionId}/unlock.html`, frameId: 1 }, type)).toThrow();
    if (popupAllowed.includes(type)) expect(() => authorizePageMessage(page, type)).not.toThrow();
    else expect(() => authorizePageMessage(page, type)).toThrow();
  });
  it('keeps sender validation and denies unrecognized or content messages', () => {
    expect(() => authorizePageMessage(content, 'qf.get_profiles')).toThrow();
    for (const type of ['qf.trace_read', 'qf.trace_event', 'qf.content_profiles', 'qf.unknown'])
      expect(() => authorizePageMessage(page, type)).toThrow();
    expect(() => authorizePageMessage({ ...page, url: `${page.url}?editor=1&profile=L1` }, 'qf.update_profile')).not.toThrow();
  });
});

describe('content sender boundary', () => {
  it('derives the origin from the actual sender URL and accepts tab zero', () => {
    expect(contentContext(content)).toEqual({ tabId: 7, origin: 'https://site.example' });
    expect(contentContext({ ...content, url: 'http://localhost:8080/form', tab: { id: 0 } } as chrome.runtime.MessageSender)).toEqual({ tabId: 0, origin: 'http://localhost:8080' });
  });

  it.each([
    {}, page, { ...content, id: undefined }, { ...content, id: 'external-extension' },
    { ...content, frameId: undefined }, { ...content, frameId: 1 },
    { ...content, tab: undefined }, { ...content, tab: { id: -1 } },
    { ...content, tab: { id: 1.5 } }, { ...content, tab: { id: Number.NaN } },
    { ...content, tab: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...content, url: undefined }, { ...content, url: 'invalid' },
    { ...content, url: 'about:blank' }, { ...content, url: 'data:text/html,synthetic' },
    { ...content, url: 'blob:https://site.example/synthetic' },
    { ...content, url: 'file:///synthetic.html' }, { ...content, url: 'https://' },
  ])('rejects missing, opaque, external, or subframe context %#', sender => {
    expect(() => contentContext(sender as chrome.runtime.MessageSender)).toThrow();
  });
});

describe('message authorization classification', () => {
  it.each(['qf.get_profiles', 'qf.update_profile', 'qf.delete_profile', 'qf.touch_profile', 'qf.add_blacklist', 'qf.remove_blacklist', 'qf.clear_all', 'qf.export', 'qf.export_raw', 'qf.import', 'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_lock', 'qf.vault_change', 'qf.vault_export', 'qf.vault_restore'])('keeps management message %s page-only', type => {
    expect(classifyMessage(type)).toBe('page');
  });
  it.each(['qf.content_profiles', 'qf.fill_profile', 'qf.capture_begin', 'qf.pending_put', 'qf.pending_get', 'qf.pending_drop', 'qf.pending_save', 'qf.pending_blacklist'])('limits website request %s to content context', type => {
    expect(classifyMessage(type)).toBe('content');
  });
  it.each(['qf.trace_status', 'qf.trace_read', 'qf.trace_set', 'qf.trace_event'])('leaves %s to the dedicated trace policy', type => {
    expect(classifyMessage(type)).toBe('shared');
  });
  it.each(['', 'unknown', 'qf.pending_unknown', 'qf.trace_unknown', 'qf.vault_unknown', 'qf.profiles', 'qf.error'])('denies unknown or response-only type %s', type => {
    expect(classifyMessage(type)).toBe('deny');
  });
});

describe('content metadata minimization', () => {
  const stored: Stored = {
    version: 1,
    profiles: [
      { id: 'L1', kind: 'login', url: 'https://site.example', username: 'synthetic-user', password: 'same-origin-synthetic-password', updatedAt: 1 },
      { id: 'L2', kind: 'login', url: 'https://other.example', username: 'cross-origin-synthetic-user', password: 'cross-origin-synthetic-password', updatedAt: 2 },
      { id: 'I1', kind: 'identity', label: 'Synthetic home', fields: { name: 'synthetic-full-name', email: 'synthetic-email@example.test', tel: 'synthetic-phone', 'street-address': 'synthetic-street' }, updatedAt: 3 },
    ],
    blacklist: ['https://other.example', 'https://site.example', 'https://site.example'],
  };

  it('returns only matching login labels, identity field names, and the current blacklist origin', () => {
    const result = summarizeForContent(stored, 'https://site.example');
    expect(result).toEqual({ profiles: [
      { id: 'L1', kind: 'login', url: 'https://site.example', username: 'synthetic-user', password: '', updatedAt: 1 },
      { id: 'I1', kind: 'identity', label: 'Synthetic home', fields: { name: '', email: '', tel: '', 'street-address': '' }, updatedAt: 3 },
    ], blacklist: ['https://site.example'] });
    const serialized = JSON.stringify(result);
    for (const secret of ['same-origin-synthetic-password', 'cross-origin-synthetic-password', 'cross-origin-synthetic-user', 'synthetic-full-name', 'synthetic-email@example.test', 'synthetic-phone', 'synthetic-street', 'https://other.example']) expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized)).toEqual(result);
  });

  it('does not reveal other-origin credentials or blacklist entries when no login matches', () => {
    const result = summarizeForContent(stored, 'https://third.example');
    expect(result.profiles.map(p => p.kind)).toEqual(['identity']);
    expect(result.blacklist).toEqual([]);
  });

  it('does not mutate or share nested profile objects with storage', () => {
    const original = structuredClone(stored);
    const result = summarizeForContent(stored, 'https://site.example');
    result.profiles[0]!.id = 'changed';
    const identity = result.profiles.find(p => p.kind === 'identity')!;
    if (identity.kind === 'identity') identity.fields.name = 'changed';
    result.blacklist.push('https://third.example');
    expect(stored).toEqual(original);
  });
});


it('includes optional last-used metadata in redacted content summaries', () => {
  const profiles: Stored['profiles'] = [
    { id: 'login', kind: 'login', url: 'https://site.example', username: 'synthetic', password: 'synthetic-secret', updatedAt: 1, lastUsedAt: 20 },
    { id: 'identity', kind: 'identity', label: 'Synthetic', fields: { name: 'synthetic-private-name' }, updatedAt: 2, lastUsedAt: 30 },
  ];
  expect(summarizeForContent({ version: 1, profiles, blacklist: [] }, 'https://site.example').profiles).toEqual([
    { ...profiles[0], password: '' },
    { ...profiles[1], fields: { name: '' } },
  ]);
});
