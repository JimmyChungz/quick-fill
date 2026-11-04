export type VaultEnvelope = {
  format: 'qf-vault';
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000; salt: string };
  cipher: { name: 'AES-GCM'; iv: string; data: string };
};

const MAX_CIPHER_BYTES = 20 * 1024 * 1024;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isBase64(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0
    || value.length > 4 * Math.ceil(maxBytes / 3) || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const firstPadding = value.indexOf('=');
  if (firstPadding !== -1 && firstPadding !== value.length - padding) return false;
  const bytes = value.length / 4 * 3 - padding;
  if (bytes < minBytes || bytes > maxBytes) return false;
  // Reject noncanonical unused bits, so one byte sequence has one encoding.
  const last = BASE64.indexOf(value.charAt(value.length - padding - 1));
  return padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function requireSalt(salt: unknown): asserts salt is string {
  if (!isBase64(salt, 16, 16)) throw new Error('Invalid vault salt');
}

function additionalData(salt: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`qf-vault:1:PBKDF2:SHA-256:600000:AES-GCM:${salt}`);
}

export function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  if (!hasKeys(value, ['format', 'version', 'kdf', 'cipher'])
    || value.format !== 'qf-vault' || value.version !== 1
    || !hasKeys(value.kdf, ['name', 'hash', 'iterations', 'salt'])
    || !hasKeys(value.cipher, ['name', 'iv', 'data'])) return false;
  return value.kdf.name === 'PBKDF2' && value.kdf.hash === 'SHA-256'
    && value.kdf.iterations === 600000 && isBase64(value.kdf.salt, 16, 16)
    && value.cipher.name === 'AES-GCM' && isBase64(value.cipher.iv, 12, 12)
    && isBase64(value.cipher.data, 16, MAX_CIPHER_BYTES);
}

/** Material is an unlock secret: callers may retain it only in trusted session memory. */
export async function deriveVaultMaterial(password: string, saltB64: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    throw new Error('Master password must contain 8 to 1024 characters');
  }
  requireSalt(saltB64);
  const passwordBytes = encoder.encode(password);
  try {
    const source = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    const bytes = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: decodeBase64(saltB64),
    }, source, 256));
    try { return encodeBase64(bytes); } finally { bytes.fill(0); }
  } finally {
    passwordBytes.fill(0);
  }
}

export async function importVaultKey(material: string): Promise<CryptoKey> {
  if (!isBase64(material, 32, 32)) throw new Error('Invalid vault key material');
  const bytes = decodeBase64(material);
  try {
    return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

export async function deriveVaultKey(password: string, saltB64: string): Promise<CryptoKey> {
  return importVaultKey(await deriveVaultMaterial(password, saltB64));
}

export async function encryptVault(value: unknown, key: CryptoKey, saltB64: string): Promise<VaultEnvelope> {
  requireSalt(saltB64);
  if (key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new Error('Vault encryption requires an AES-256-GCM key');
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Vault data must be JSON');
  const plaintext = encoder.encode(json);
  try {
    if (plaintext.length > MAX_CIPHER_BYTES - 16) throw new Error('Vault data exceeds size limit');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: additionalData(saltB64), tagLength: 128,
    }, key, plaintext);
    return {
      format: 'qf-vault', version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: saltB64 },
      cipher: { name: 'AES-GCM', iv: encodeBase64(iv), data: encodeBase64(new Uint8Array(ciphertext)) },
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Authentication precedes JSON parsing; the storage layer validates the resulting schema. */
export async function decryptVault(envelope: unknown, key: CryptoKey): Promise<unknown> {
  if (!isVaultEnvelope(envelope)) throw new Error('Invalid vault envelope');
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: decodeBase64(envelope.cipher.iv),
      additionalData: additionalData(envelope.kdf.salt), tagLength: 128,
    }, key, decodeBase64(envelope.cipher.data)));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new Error('Unable to decrypt vault');
  } finally {
    plaintext?.fill(0);
  }
}

export async function createVault(value: unknown, password: string): Promise<{
  envelope: VaultEnvelope; key: CryptoKey; material: string;
}> {
  const salt = encodeBase64(crypto.getRandomValues(new Uint8Array(16)));
  const material = await deriveVaultMaterial(password, salt);
  const key = await importVaultKey(material);
  return { envelope: await encryptVault(value, key, salt), key, material };
}
