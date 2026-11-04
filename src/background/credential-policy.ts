import {vaultStatus} from './vault';
import {isProfile} from '../lib/storage-schema';
import type {FieldToken} from '../lib/types';

/** Only the worker calls this before accepting credential writes. Legacy data
 * stays readable/exportable; no password is chosen or migrated automatically. */
export async function requireEncryptedCredentials(profiles: readonly unknown[]): Promise<void> {
  const containsPassword = profiles.some(profile => {
    if (!isProfile(profile)) return false;
    if (profile.kind === 'login') return profile.password !== '';
    // Keep the runtime guard even though identity validation now rejects these
    // keys; imported/hand-edited data must never bypass the Vault gate.
    const fields = profile.fields as Partial<Record<FieldToken, string>>;
    return !!(fields['current-password'] || fields['new-password']);
  });
  if (!containsPassword) return;
  if (!(await vaultStatus()).enabled)
    throw Error('保存登录密码前，请先在管理页“密码库安全”设置主密码并开启加密；现有记录未修改');
}
