import type { Stored, Profile, IdentityProfile, FieldToken, IdentityToken } from './types';
import { normalizeOrigin } from './origin';
import { ALL_TOKENS, isIdentityToken } from './tokens';

/** Key holding the whole store. */
export const KEY = 'qf.stored.v1';
/** Key holding the "we captured a credential, ask on the next page" record. */
export const PENDING_KEY = 'qf.pendingBanner';
export const GENERATION_KEY = 'qf.generation';

/** How many records a single import may carry. */
export const MAX_IMPORT = 5000;
const MAX_VALUE = 65536;
const bounded = (v: unknown, max = MAX_VALUE): v is string =>
  typeof v === 'string' && v.length <= max;
export const validOrigin = (v: unknown): v is string => {
  if (!bounded(v, 4096)) return false;
  try {
    const url = new URL(v);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
};

/**
 * A fresh empty store.
 *
 * This used to be a module-level `Object.freeze`d constant, but `Object.freeze`
 * is shallow: `{ ...EMPTY_STORED }` copies the object and *shares* the `profiles`
 * array, so the first `upsertProfile` against an empty store pushed into the
 * constant itself — and every later "empty" read handed that same polluted
 * array back. A factory makes shared mutable state impossible.
 */
export function emptyStored(): Stored {
  return { version: 1, profiles: [], blacklist: [] };
}

function isKnownIdentityToken(token: string): token is IdentityToken {
  return (
    (ALL_TOKENS as string[]).includes(token) &&
    isIdentityToken(token as FieldToken)
  );
}

function isIdentityFields(x: unknown, allowLegacyCredentials: boolean): x is IdentityProfile['fields'] {
  return (
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    Object.keys(x).length <= ALL_TOKENS.length &&
    Object.keys(x).every(token => isKnownIdentityToken(token) ||
      (allowLegacyCredentials && (ALL_TOKENS as string[]).includes(token))) &&
    Object.values(x as Record<string, unknown>).every((v) => bounded(v))
  );
}

/**
 * Validates a single record. Anything arriving from outside the extension (an
 * import file, a hand-edited store) must pass this before it can reach a
 * renderer — `Object.values(p.fields)` used to throw on a malformed row, taking
 * the whole popup list down with it.
 */
export function isProfile(x: unknown): x is Profile {
  return isProfileShape(x, false);
}

function isProfileShape(x: unknown, allowLegacyCredentials: boolean): x is Profile {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (!bounded(p.id, 256) || p.id === '') return false;
  if (
    typeof p.updatedAt !== 'number' ||
    !Number.isFinite(p.updatedAt) ||
    p.updatedAt < 0
  )
    return false;
  if (p.lastUsedAt !== undefined && (
    typeof p.lastUsedAt !== 'number' ||
    !Number.isFinite(p.lastUsedAt) ||
    p.lastUsedAt < 0
  )) return false;
  if (p.kind === 'login') {
    return (
      validOrigin(p.url) && bounded(p.username, 2048) && bounded(p.password)
    );
  }
  if (p.kind === 'identity') {
    return bounded(p.label, 512) && isIdentityFields(p.fields, allowLegacyCredentials);
  }
  return false;
}

function isStored(x: unknown): x is Stored {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return (
    s.version === 1 && Array.isArray(s.profiles) && Array.isArray(s.blacklist)
  );
}

/** Preserve known legacy keys on reads; imports and edits validate strictly first. */
function sanitizeFields(
  fields: IdentityProfile['fields'],
): IdentityProfile['fields'] {
  const out: IdentityProfile['fields'] = {};
  for (const [k, v] of Object.entries(fields)) {
    if ((ALL_TOKENS as string[]).includes(k)) out[k as keyof typeof out] = v;
  }
  return out;
}

export function sanitizeProfile(p: Profile): Profile {
  if (p.kind === 'login') return { ...p, url: normalizeOrigin(p.url) || p.url };
  return { ...p, fields: sanitizeFields(p.fields) };
}

export function validateStored(raw: unknown): Stored {
  if (raw === undefined) return emptyStored();
  if (!isStored(raw)) {
    throw new Error(
      '本地数据格式异常，已保留原数据并停止写入。请先导出原始数据恢复。',
    );
  }
  // Older schema-v1 stores allowed credential tokens in identities. Retain
  // those known fields without admitting them through the new-write gate.
  const valid = raw.profiles.filter(profile => isProfileShape(profile, true));
  if (valid.length !== raw.profiles.length) {
    throw new Error('本地记录损坏，已保留原数据并停止写入。');
  }
  if (
    raw.profiles.length > MAX_IMPORT ||
    raw.blacklist.some((o) => !validOrigin(o))
  )
    throw new Error('本地数据超限或黑名单格式异常');
  return {
    version: 1,
    profiles: valid.map(sanitizeProfile),
    blacklist: raw.blacklist.filter((o): o is string => typeof o === 'string'),
  };
}
