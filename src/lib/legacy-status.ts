import type {Profile} from './types';
/** Count only, never returns credential values or chooses a migration action. */
export function countLegacyPasswords(profiles: readonly Profile[]): number {
  return profiles.filter(profile => {
    if (profile.kind === 'login') return profile.password !== '';
    const fields = profile.fields as Record<string, string | undefined>;
    return !!(fields['current-password'] || fields['new-password']);
  }).length;
}
