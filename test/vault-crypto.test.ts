import { pbkdf2Sync, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createVault, decryptVault, deriveVaultKey, deriveVaultMaterial,
  encryptVault, importVaultKey, isVaultEnvelope, type VaultEnvelope,
} from '../src/lib/vault-crypto';

const password = 'synthetic master passphrase 🔐';
const salt = 'AAECAwQFBgcICQoLDA0ODw==';
const value = { version: 1, profiles: [{ username: '测试@example.invalid', password: '合成🔑' }], blacklist: [] };
const fixture: VaultEnvelope = {
  format: 'qf-vault', version: 1,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
  cipher: { name: 'AES-GCM', iv: 'AAECAwQFBgcICQoL', data: 'AAAAAAAAAAAAAAAAAAAAAA==' },
};

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe('vault cryptography', () => {
  it('round trips Unicode JSON with a non-extractable AES-256 key', async () => {
    const { envelope, key } = await createVault(value, password);
    expect(isVaultEnvelope(envelope)).toBe(true);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect(await decryptVault(envelope, key)).toEqual(value);
    expect(JSON.stringify(envelope)).not.toContain('example.invalid');
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('derives the standard PBKDF2-SHA256 600000-iteration 256-bit material', async () => {
    const expected = pbkdf2Sync(password, Buffer.from(salt, 'base64'), 600000, 32, 'sha256').toString('base64');
    expect(await deriveVaultMaterial(password, salt)).toBe(expected);
    const key = await deriveVaultKey(password, salt);
    const envelope = await encryptVault(value, key, salt);
    expect(await decryptVault(envelope, await importVaultKey(expected))).toEqual(value);
  });

  it('returns session material that restores the created vault without retaining the password', async () => {
    const { envelope, material } = await createVault(value, password);
    expect(Buffer.from(material, 'base64')).toHaveLength(32);
    const restored = await importVaultKey(material);
    expect(restored.extractable).toBe(false);
    expect(await decryptVault(envelope, restored)).toEqual(value);
  });

  it('uses an independent random salt for every new vault', async () => {
    const first = await createVault(value, password);
    const second = await createVault(value, password);
    expect(Buffer.from(first.envelope.kdf.salt, 'base64')).toHaveLength(16);
    expect(first.envelope.kdf.salt).not.toBe(second.envelope.kdf.salt);
    expect(first.material).not.toBe(second.material);
  });

  it('uses a fresh 96-bit IV for each write with the same key and salt', async () => {
    const { envelope, key } = await createVault(value, password);
    const next = await encryptVault(value, key, envelope.kdf.salt);
    expect(Buffer.from(next.cipher.iv, 'base64')).toHaveLength(12);
    expect(next.cipher.iv).not.toBe(envelope.cipher.iv);
    expect(next.cipher.data).not.toBe(envelope.cipher.data);
    expect(await decryptVault(next, key)).toEqual(value);
  });

  it('rejects a wrong password without yielding plaintext', async () => {
    const { envelope } = await createVault(value, password);
    const wrong = await deriveVaultKey('different synthetic passphrase', envelope.kdf.salt);
    await expect(decryptVault(envelope, wrong)).rejects.toThrow();
  });

  it('authenticates ciphertext, IV, salt, and a truncated authentication tag', async () => {
    const { envelope, key } = await createVault(value, password);
    const changed = (text: string) => `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`;
    const mutations = [
      { ...envelope, cipher: { ...envelope.cipher, data: changed(envelope.cipher.data) } },
      { ...envelope, cipher: { ...envelope.cipher, iv: changed(envelope.cipher.iv) } },
      { ...envelope, kdf: { ...envelope.kdf, salt: changed(envelope.kdf.salt) } },
      { ...envelope, cipher: { ...envelope.cipher, data: Buffer.from(Buffer.from(envelope.cipher.data, 'base64').subarray(0, -1)).toString('base64') } },
    ];
    for (const mutation of mutations) await expect(decryptVault(mutation, key)).rejects.toThrow();
  });

  it.each(['short', 'x'.repeat(7), 'x'.repeat(1025)])('rejects an out-of-bounds master password', async (invalid) => {
    await expect(createVault(value, invalid)).rejects.toThrow();
    await expect(deriveVaultMaterial(invalid, salt)).rejects.toThrow();
    await expect(deriveVaultKey(invalid, salt)).rejects.toThrow();
  });

  it('accepts both master-password length boundaries without trimming', async () => {
    for (const valid of [' '.repeat(8), 'x'.repeat(1024)]) {
      const { envelope, key } = await createVault(null, valid);
      expect(await decryptVault(envelope, key)).toBeNull();
    }
  });

  it('rejects malformed key material and salt before invoking cryptography', async () => {
    for (const invalid of ['', '!', 'AA==', 'A'.repeat(44), 'A'.repeat(45)]) {
      await expect(importVaultKey(invalid)).rejects.toThrow();
    }
    await expect(deriveVaultKey(password, 'AA==')).rejects.toThrow();
    const key = await importVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await expect(encryptVault(value, key, 'AA==')).rejects.toThrow();
    await expect(encryptVault(undefined, key, salt)).rejects.toThrow();
    await expect(encryptVault('x'.repeat(20 * 1024 * 1024), key, salt)).rejects.toThrow();
  });

  it('validates the envelope before decryption', async () => {
    const key = await importVaultKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await expect(decryptVault({ ...fixture, version: 2 }, key)).rejects.toThrow();
  });

  it('rejects encryption with an AES-128 key instead of producing a mislabeled vault', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
    await expect(encryptVault(value, key, salt)).rejects.toThrow();
  });
});

describe('vault envelope validation', () => {
  it('accepts the strict v1 format with a full authentication tag', () => {
    expect(isVaultEnvelope(fixture)).toBe(true);
  });

  it.each([
    null, [], {}, { ...fixture, extra: true }, { ...fixture, format: 'other' }, { ...fixture, version: 2 },
    { ...fixture, kdf: { ...fixture.kdf, extra: true } },
    { ...fixture, kdf: { ...fixture.kdf, name: 'scrypt' } },
    { ...fixture, kdf: { ...fixture.kdf, hash: 'SHA-1' } },
    { ...fixture, kdf: { ...fixture.kdf, iterations: 1 } },
    { ...fixture, kdf: { ...fixture.kdf, iterations: '600000' } },
    { ...fixture, kdf: { ...fixture.kdf, salt: 'AA==' } },
    { ...fixture, kdf: { ...fixture.kdf, salt: 'AAECAwQFBgcICQoLDA0ODx==' } },
    { ...fixture, cipher: { ...fixture.cipher, extra: true } },
    { ...fixture, cipher: { ...fixture.cipher, name: 'AES-CBC' } },
    { ...fixture, cipher: { ...fixture.cipher, iv: 'AA==' } },
    { ...fixture, cipher: { ...fixture.cipher, data: 'AAAAAAAAAAAAAAAAAAAA' } },
    { ...fixture, cipher: { ...fixture.cipher, data: 'AAAAAAAAAAAAAAAAAAAAAA' } },
    { ...fixture, cipher: { ...fixture.cipher, data: 'AAAAAAAAAAAAAAAAAAAAAA==\n' } },
    { ...fixture, cipher: { ...fixture.cipher, data: 'AAAAAAAAAAAAAAAAAAAAA_==' } },
    { ...fixture, cipher: { ...fixture.cipher, data: 'A'.repeat(4 * Math.ceil((20 * 1024 * 1024 + 1) / 3)) } },
  ])('rejects malformed, unsupported, noncanonical, or oversized envelopes %#', (invalid) => {
    expect(isVaultEnvelope(invalid)).toBe(false);
  });
});
