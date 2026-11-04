import {requireEncryptedCredentials} from './credential-policy';
import { handleCaptureTrace } from './capture-trace';
import { handleInlineUnlock, isInlineUnlockMessage } from './inline-unlock';
import { vaultStatus, setupVault, unlockVault, lockVault, changeVaultPassword, exportVault, restoreVault } from './vault';
import { authorizePageMessage, classifyMessage, contentContext, summarizeForContent } from '../lib/message-policy';
import {
  getStored,
  upsertProfile,
  deleteProfile,
  addBlacklist,
  removeBlacklist,
  importProfiles,
  clearAll,
  getGeneration,
  touchProfile,
  PENDING_KEY,
  KEY,
  GENERATION_KEY,
  isProfile,
} from '../lib/storage';
import type { Message, PendingCredential, LoginProfile } from '../lib/types';

const SESSION_KEY = 'qf.pending.v2';
const TTL = 5 * 60 * 1000;
const PERMITS = 'qf.capture-permits',
  RECEIPTS = 'qf.receipts';
type Permit = {
  id: string;
  tabId: number;
  origin: string;
  generation: string;
  createdAt: number;
};
type Receipt = Permit & { action: string };
async function sessionMap<T>(key: string): Promise<Record<string, T>> {
  const data = (await chrome.storage.session.get(key))[key];
  return data && typeof data === 'object' ? data : {};
}
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

// Register listeners below synchronously, while all handlers wait for storage
// isolation. Only old test doubles omit these Chrome 120+ methods.
const storageReady = Promise.all([chrome.storage.local, chrome.storage.session].map(async area => {
  if (typeof area.setAccessLevel === 'function') await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}));
void storageReady.catch(() => {});

function pendingDecision(stored: Awaited<ReturnType<typeof getStored>>, candidate: { origin: string; username: string; password: string }): { reason?: 'blacklisted' | 'unchanged'; existing?: LoginProfile } {
  if (stored.blacklist.includes(candidate.origin)) return { reason: 'blacklisted' };
  const logins = stored.profiles.filter((p): p is LoginProfile => p.kind === 'login' && p.url === candidate.origin);
  if (logins.some(p => p.username === candidate.username && p.password === candidate.password)) return { reason: 'unchanged' };
  const same = logins.filter(p => candidate.username !== '' && p.username === candidate.username);
  return { existing: same.length === 1 ? same[0] : undefined };
}
const existingMetadata = (profile?: LoginProfile): LoginProfile | undefined => profile ? {
  id: profile.id, kind: 'login', url: profile.url, username: profile.username, password: '', updatedAt: profile.updatedAt,
} : undefined;
async function pendingRecords(): Promise<Record<string, PendingCredential>> {
  const raw = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  const records: Record<string, PendingCredential> = {};
  const now = Date.now(),
    generation = await getGeneration();
  if (raw && typeof raw === 'object')
    for (const [id, p] of Object.entries(raw) as Array<
      [string, PendingCredential]
    >) {
      if (
        p &&
        p.id === id &&
        Number.isSafeInteger(p.tabId) && p.tabId >= 0 &&
        p.generation === generation &&
        Number.isFinite(p.createdAt) &&
        p.createdAt <= now &&
        now - p.createdAt < TTL &&
        isProfile({
          id,
          kind: 'login',
          url: p.origin,
          username: p.username,
          password: p.password,
          updatedAt: p.createdAt,
        })
      )
        records[id] = p;
    }
  return records;
}
async function writePending(
  records: Record<string, PendingCredential>,
): Promise<void> {
  if (Object.keys(records).length)
    await chrome.storage.session.set({ [SESSION_KEY]: records });
  else await chrome.storage.session.remove(SESSION_KEY);
}
async function profilesResponse(
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const s = await getStored();
  return {
    type: 'qf.profiles',
    profiles: s.profiles,
    blacklist: s.blacklist,
    generation: await getGeneration(),
    ...extra,
  };
}
async function handle(
  msg: Message,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  await storageReady;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string')
    throw Error('消息格式不正确');
  if (isInlineUnlockMessage(msg.type)) return handleInlineUnlock(msg, sender, broadcastDataChanged);
  if (msg.type === 'qf.trace_status' || msg.type === 'qf.trace_read' || msg.type === 'qf.trace_set' || msg.type === 'qf.trace_event')
    return handleCaptureTrace(msg, sender);
  const realm = classifyMessage(msg.type);
  if (realm === 'page') authorizePageMessage(sender, msg.type);
  else if (realm === 'content') contentContext(sender);
  else throw Error('不支持的消息类型');
  const generation = await getGeneration();
  const reads = new Set([
    'qf.get_profiles',
    'qf.content_profiles',
    'qf.export',
    'qf.export_raw',
    'qf.pending_get',
    'qf.capture_begin',
    'qf.pending_put',
    'qf.vault_status', 'qf.vault_setup', 'qf.vault_unlock', 'qf.vault_lock',
    'qf.vault_change', 'qf.vault_export', 'qf.vault_restore',
  ]);
  if (!reads.has(msg.type) && msg.generation !== generation)
    throw Error('数据已清空或更新，请刷新后重试');
  switch (msg.type) {
    case 'qf.vault_status':
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.vault_setup':
      await setupVault(msg.password);
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.vault_unlock':
      await unlockVault(msg.password);
      await broadcastDataChanged();
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.vault_lock':
      await lockVault();
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.vault_change':
      await changeVaultPassword(msg.oldPassword, msg.newPassword);
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.vault_export':
      return { type: 'qf.vault_export', envelope: await exportVault(msg.recovery === true), generation };
    case 'qf.vault_restore':
      await restoreVault(msg.envelope, msg.password);
      return { type: 'qf.vault_status', ...await vaultStatus(), generation: await getGeneration() };
    case 'qf.get_profiles':
      return profilesResponse();
    case 'qf.content_profiles': {
      const { origin } = contentContext(sender);
      return { type: 'qf.profiles', ...summarizeForContent(await getStored(), origin), generation };
    }
    case 'qf.fill_profile': {
      const { origin } = contentContext(sender);
      if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 256) throw Error('记录 ID 不正确');
      const profile = (await getStored()).profiles.find(p => p.id === msg.id);
      if (!profile || (profile.kind === 'login' && profile.url !== origin)) throw Error('记录不存在或不属于此页面');
      // Recency persistence is optional, but authorization can expire while
      // it is awaited. Recheck authority before returning any stored values.
      try { await touchProfile(profile.id); }
      catch { /* Best-effort only; no credential values are logged. */ }
      const status = await vaultStatus();
      if (await getGeneration() !== generation) throw Error('数据已清空或更新，请刷新后重试');
      if (status.enabled && (!status.unlocked || status.expiresAt === null || Date.now() >= status.expiresAt))
        throw Error('密码库已锁定，请重新解锁');
      return { type: 'qf.profile', profile, generation };
    }
    case 'qf.export_raw':
      return {
        type: 'qf.raw',
        raw: (await chrome.storage.local.get(KEY))[KEY] ?? null,
        generation,
      };
    case 'qf.capture_begin': {
      const { tabId, origin } = contentContext(sender);
      await getStored();
      if (!(typeof msg.id === 'string' && msg.id.length >= 1 && msg.id.length <= 128 && !/[^a-zA-Z0-9-]/.test(msg.id))) throw Error('候选 ID 不正确');
      const permits = await sessionMap<Permit>(PERMITS);
      permits[String(tabId)] = {
        id: msg.id,
        tabId,
        origin,
        generation,
        createdAt: Date.now(),
      };
      await chrome.storage.session.set({ [PERMITS]: permits });
      return { type: 'qf.ok', generation };
    }
    case 'qf.update_profile':
      await requireEncryptedCredentials([msg.profile]);
      await upsertProfile(msg.profile, msg);
      return profilesResponse();
    case 'qf.touch_profile':
      await touchProfile(msg.id);
      return { type: 'qf.ok', generation };
    case 'qf.delete_profile':
      await deleteProfile(msg.id);
      return profilesResponse();
    case 'qf.add_blacklist':
      await addBlacklist(msg.origin);
      return profilesResponse();
    case 'qf.remove_blacklist':
      await removeBlacklist(msg.origin);
      return profilesResponse();
    case 'qf.clear_all':
      await clearAll();
      return profilesResponse();
    case 'qf.export':
      return {
        version: 1,
        exportedAt: Date.now(),
        profiles: (await getStored()).profiles,
        generation,
      };
    case 'qf.import': {
      if (msg.payload?.version !== 1 || !Array.isArray(msg.payload.profiles))
        throw Error('导入格式不正确');
      await requireEncryptedCredentials(msg.payload.profiles);
      const { imported, rejected } = await importProfiles(msg.payload.profiles);
      return profilesResponse({ imported, rejected });
    }
    case 'qf.pending_put': {
      const { tabId, origin } = contentContext(sender),
        c = msg.candidate;
      const stored = await getStored();
      if (
        !(typeof msg.id === 'string' && msg.id.length >= 1 && msg.id.length <= 128 && !/[^a-zA-Z0-9-]/.test(msg.id)) ||
        c?.origin !== origin ||
        !c.password ||
        !isProfile({
          id: msg.id,
          kind: 'login',
          url: origin,
          username: c.username,
          password: c.password,
          updatedAt: Date.now(),
        })
      )
        throw Error('候选格式不正确');
      const records = await pendingRecords();
      const permit = (await sessionMap<Permit>(PERMITS))[String(tabId)];
      const prior = records[msg.id];
      if (
        !prior &&
        (!permit ||
          permit.id !== msg.id ||
          permit.origin !== origin ||
          permit.generation !== generation ||
          Date.now() - permit.createdAt >= TTL)
      )
        throw Error('捕获已过期或数据已清空，请重新聚焦并提交');
      if (prior && (prior.tabId !== tabId || prior.origin !== origin))
        throw Error('候选 ID 冲突');
      const { reason, existing } = pendingDecision(stored, c);
      if (reason) {
        delete records[msg.id];
        await writePending(records);
        return { type: 'qf.pending', pending: null, generation, reason };
      }
      for (const [id, p] of Object.entries(records))
        if (p.tabId === tabId && id !== msg.id) delete records[id];
      const p: PendingCredential = prior ?? {
        ...c,
        id: msg.id,
        tabId,
        createdAt: Date.now(),
        generation,
        targetId: existing?.id,
        targetUpdatedAt: existing?.updatedAt,
      };
      records[msg.id] = p;
      await writePending(records);
      await chrome.alarms.create(`qf.pending:${msg.id}`, {
        when: p.createdAt + TTL,
      });
      return { type: 'qf.pending', pending: p, existing: existingMetadata(existing), generation };
    }
    case 'qf.pending_get': {
      const { tabId, origin } = contentContext(sender),
        records = await pendingRecords();
      const stored = await getStored();
      await writePending(records);
      const p =
        Object.values(records)
          .filter((p) => p.tabId === tabId && p.origin === origin)
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      const decision = p ? pendingDecision(stored, p) : {};
      if (p && decision.reason) {
        delete records[p.id];
        await writePending(records);
        return { type: 'qf.pending', pending: null, generation, reason: decision.reason };
      }
      return { type: 'qf.pending', pending: p, existing: existingMetadata(decision.existing), generation };
    }
    case 'qf.pending_save':
    case 'qf.pending_drop':
    case 'qf.pending_blacklist': {
      await getStored();
      const { tabId, origin } = contentContext(sender),
        records = await pendingRecords(),
        p = records[msg.id];
      const receipts = await sessionMap<Receipt>(RECEIPTS);
      for (const [id, r] of Object.entries(receipts))
        if (
          !r ||
          r.generation !== generation ||
          Date.now() - r.createdAt >= TTL
        )
          delete receipts[id];
      const receipt = receipts[msg.id];
      if (
        receipt &&
        receipt.tabId === tabId &&
        receipt.origin === origin &&
        receipt.action === msg.type
      )
        return { type: 'qf.ok', generation };
      if (!p || p.tabId !== tabId || p.origin !== origin)
        throw Error('候选已过期、已清空或不属于此页面');
      if (msg.type === 'qf.pending_save') {
        await requireEncryptedCredentials([{id:p.id,kind:'login',url:p.origin,username:p.username,password:p.password,updatedAt:Date.now()}]);
        const s = await getStored();
        if (s.blacklist.includes(origin))
          throw Error('此站已设置为永不保存，未保存此候选');
        const logins = s.profiles.filter(
          (x): x is LoginProfile => x.kind === 'login' && x.url === origin,
        );
        if (
          !logins.some(
            (x) => x.username === p.username && x.password === p.password,
          )
        ) {
          const existing = p.targetId
            ? logins.find((x) => x.id === p.targetId)
            : undefined;
          if (
            p.targetId &&
            (!existing || existing.updatedAt !== p.targetUpdatedAt)
          )
            throw Error('账号已在其他页面修改，请重新提交以确认更新');
          if (
            !p.targetId &&
            p.username !== '' &&
            logins.some((x) => x.username === p.username)
          )
            throw Error('同名账号已变化，请重新提交以确认');
          await upsertProfile(
            {
              id: existing?.id ?? `capture-${p.id}`,
              kind: 'login',
              url: origin,
              username: p.username,
              password: p.password,
              updatedAt: Date.now(),
            },
            {
              create: existing ? false : true,
              expectedUpdatedAt: existing?.updatedAt,
            },
          );
        }
      } else if (msg.type === 'qf.pending_blacklist')
        await addBlacklist(origin);
      receipts[msg.id] = {
        id: msg.id,
        tabId,
        origin,
        generation,
        createdAt: Date.now(),
        action: msg.type,
      };
      delete records[msg.id];
      // Candidate removal and credential-free receipt are committed together.
      await chrome.storage.session.set({
        [SESSION_KEY]: records,
        [RECEIPTS]: receipts,
      });
      return { type: 'qf.ok', generation };
    }
    default:
      throw Error('不支持的消息类型');
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => handle(msg as Message, sender))
    .then(sendResponse)
    .catch((err) =>
      sendResponse({
        type: 'qf.error',
        message: err instanceof Error ? err.message : '操作失败',
      }),
    );
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  void serial(async () => {
    await storageReady;
    await chrome.storage.local.remove(PENDING_KEY);
    await writePending(await pendingRecords());
  }).catch(() => {});
});
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'qf.vault-lock')
    void serial(async () => { await storageReady; await vaultStatus(); }).catch(() => {});
  if (alarm.name.startsWith('qf.pending:'))
    void serial(async () => { await storageReady; await writePending(await pendingRecords()); }).catch(
      () => {},
    );
});
async function broadcastDataChanged(): Promise<void> {
  await storageReady;
  if (typeof chrome.tabs?.query !== 'function' || typeof chrome.tabs.sendMessage !== 'function') return;
  const status = await vaultStatus();
  const message = { type: 'qf.data_changed', generation: await getGeneration(), locked: !status.unlocked };
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => Number.isSafeInteger(tab.id) && tab.id! >= 0).map(async tab => {
    try { await chrome.tabs.sendMessage(tab.id!, message, { frameId: 0 }); } catch { /* A tab may have no content script. */ }
  }));
}
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes[KEY] || changes[GENERATION_KEY]))
    void serial(broadcastDataChanged).catch(() => {});
});
chrome.tabs?.onRemoved.addListener((tabId) => {
  void serial(async () => {
    await storageReady;
    const records = await pendingRecords();
    for (const [id, p] of Object.entries(records))
      if (p.tabId === tabId) delete records[id];
    await writePending(records);
  }).catch(() => {});
});
