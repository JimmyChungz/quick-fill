import {readVaultData, writeVaultData} from '../background/vault';
import type { Stored, Profile, LoginProfile, IdentityProfile } from './types';
import { normalizeOrigin } from './origin';
import {PENDING_KEY, GENERATION_KEY, MAX_IMPORT, emptyStored, isProfile, validateStored, validOrigin, sanitizeProfile} from './storage-schema';
export {KEY, PENDING_KEY, GENERATION_KEY, MAX_IMPORT, emptyStored, isProfile, validateStored} from './storage-schema';

/** Reject damaged local records, and return fresh, normalized objects. */
export async function getStored(): Promise<Stored> {
  return validateStored(await readVaultData());
}

export async function setStored(s: Stored): Promise<void> {
  await writeVaultData(s);
}

/**
 * Every mutation runs through this chain.
 *
 * Four surfaces write through the same store (content script, popup, options,
 * service worker) and every mutation is a read-modify-write, so two overlapping
 * cycles used to lose one of the writes outright. Serialising costs nothing:
 * the service worker is single-threaded anyway.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export async function getProfiles(): Promise<Profile[]> {
  return (await getStored()).profiles;
}

/** Keep normal content versions increasing without trapping legacy huge timestamps. */
function nextContentTime(previous: number, incoming: number): number {
  const next = Math.max(Date.now(), previous + 1, incoming);
  // Some old valid finite numbers cannot represent +1. A current timestamp
  // still invalidates their old edit token without rejecting the whole store.
  return next === previous ? Date.now() : next;
}

export function upsertProfile(
  profile: Profile,
  options: {
    patch?: boolean;
    create?: boolean;
    expectedUpdatedAt?: number;
  } = {},
): Promise<Stored> {
  return withWriteLock(async () => {
    if (!isProfile(profile)) {
      throw new Error('记录格式不正确');
    }
    const s = await getStored();
    const next = sanitizeProfile(profile);
    const i = s.profiles.findIndex((p) => p.id === next.id);
    if (options.create === false && i < 0)
      throw new Error('记录已删除，请刷新后重试');
    if (
      options.expectedUpdatedAt !== undefined &&
      i >= 0 &&
      s.profiles[i]!.updatedAt !== options.expectedUpdatedAt
    )
      throw new Error('记录已在其他页面更新，请刷新后重试');
    if (
      options.patch &&
      next.kind === 'identity' &&
      s.profiles[i]?.kind === 'identity'
    ) {
      const fields = {
        ...(s.profiles[i] as IdentityProfile).fields,
        ...next.fields,
      };
      for (const k of Object.keys(fields) as Array<keyof typeof fields>)
        if (fields[k] === '') delete fields[k];
      next.fields = fields;
    }
    if (next.kind === 'identity') {
      for (const k of Object.keys(next.fields) as Array<
        keyof typeof next.fields
      >)
        if (next.fields[k] === '') delete next.fields[k];
    }
    if (i < 0 && s.profiles.length >= MAX_IMPORT)
      throw new Error('记录数量已达上限');
    if (i >= 0) {
      const previous = s.profiles[i]!;
      // The worker owns content versions; same-millisecond edits must differ.
      next.updatedAt = nextContentTime(previous.updatedAt, next.updatedAt);
      if (previous.lastUsedAt === undefined) delete next.lastUsedAt;
      else next.lastUsedAt = previous.lastUsedAt;
      s.profiles[i] = next;
    }
    else s.profiles.push(next);
    await setStored(s);
    return s;
  });
}

export function deleteProfile(id: string): Promise<Stored> {
  return withWriteLock(async () => {
    const s = await getStored();
    s.profiles = s.profiles.filter((p) => p.id !== id);
    await setStored(s);
    return s;
  });
}

export function addBlacklist(origin: string): Promise<Stored> {
  return withWriteLock(async () => {
    const key = normalizeOrigin(origin) || origin;
    if (!validOrigin(key)) throw new Error('站点地址不正确');
    const s = await getStored();
    if (!s.blacklist.includes(key)) s.blacklist.push(key);
    await setStored(s);
    return s;
  });
}

export async function isBlacklisted(origin: string): Promise<boolean> {
  const key = normalizeOrigin(origin) || origin;
  const { blacklist } = await getStored();
  return blacklist.includes(key);
}

export function clearAll(): Promise<void> {
  return withWriteLock(async () => {
    // Reject a locked/unreadable encrypted primary before touching its backups.
    // Legacy raw data remains explicitly clearable without implicit migration.
    await readVaultData();
    // Revoke stale callers before cleanup. Empty-primary commit is the final
    // await: a crash after it must not leave old recovery/capture secrets.
    // An interrupted earlier clear may retain the old primary and require retry.
    await chrome.storage.local.set({[GENERATION_KEY]:crypto.randomUUID()});
    await chrome.storage.session?.remove(['qf.pending.v2','qf.capture-permits','qf.receipts','qf.inline-unlock.v1']);
    await chrome.storage.local.remove(['qf.vault.backup.v1','qf.vault.corrupt-backup.v1',PENDING_KEY]);
    await setStored(emptyStored());
  });
}

export async function getGeneration(): Promise<string> {
  const value = (await chrome.storage.local.get(GENERATION_KEY))[
    GENERATION_KEY
  ];
  if (value === undefined) return '0';
  if (typeof value !== 'string') throw new Error('数据代次损坏，已停止写入');
  return value;
}

export function touchProfile(id: string): Promise<void> {
  return withWriteLock(async () => {
    const s = await getStored();
    const p = s.profiles.find((p) => p.id === id);
    if (!p) return;
    p.lastUsedAt = Date.now();
    await setStored(s);
  });
}

export function removeBlacklist(origin: string): Promise<Stored> {
  return withWriteLock(async () => {
    const s = await getStored();
    s.blacklist = s.blacklist.filter((x) => x !== normalizeOrigin(origin));
    await setStored(s);
    return s;
  });
}

export type ImportResult = {
  stored: Stored;
  imported: number;
  rejected: number;
};

/** Compare editable content, excluding timestamps and use metadata. */
function sameContent(a: Profile, b: Profile): boolean {
  if (a.kind === 'login' && b.kind === 'login')
    return a.url === b.url && a.username === b.username && a.password === b.password;
  if (a.kind === 'identity' && b.kind === 'identity')
    return a.label === b.label &&
      Object.keys(a.fields).length === Object.keys(b.fields).length &&
      Object.entries(a.fields).every(([key, value]) => b.fields[key as keyof typeof b.fields] === value);
  return false;
}

/**
 * Merges an export file in, newest id wins. Rows failing `isProfile` are
 * rejected and reported instead of stored.
 */
export function importProfiles(
  profiles: readonly unknown[],
): Promise<ImportResult> {
  return withWriteLock(async () => {
    const accepted: Profile[] = [];
    let rejected = 0;
    for (const p of profiles) {
      if (accepted.length >= MAX_IMPORT) {
        rejected++;
        continue;
      }
      if (!isProfile(p)) {
        rejected++;
        continue;
      }
      accepted.push(sanitizeProfile(p));
    }

    const s = await getStored();
    const byId = new Map(s.profiles.map((p) => [p.id, p] as const));
    for (const p of accepted) {
      const previous = byId.get(p.id);
      if (previous) {
        p.updatedAt = sameContent(previous, p)
          ? previous.updatedAt
          : nextContentTime(previous.updatedAt, p.updatedAt);
        if (previous.lastUsedAt !== undefined)
          p.lastUsedAt = Math.max(previous.lastUsedAt, p.lastUsedAt ?? 0);
      }
      byId.set(p.id, p);
    }
    if (byId.size > MAX_IMPORT) throw new Error('合并后记录数量超过上限');
    s.profiles = Array.from(byId.values());
    await setStored(s);
    return { stored: s, imported: accepted.length, rejected };
  });
}

/** Convenience for the capture pipeline. */
export function findLogin(
  stored: Stored,
  origin: string,
  username: string,
): LoginProfile | undefined {
  return stored.profiles.find(
    (p): p is LoginProfile =>
      p.kind === 'login' && p.url === origin && p.username === username,
  );
}
