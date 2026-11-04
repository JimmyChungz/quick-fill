import { isProfile } from './storage-schema';
export function storageSummary(
  data: Record<string, unknown>,
  id: string,
  version: string,
) {
  const value = data['qf.stored.v1'];
  const store =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  const profiles = Array.isArray(store?.profiles) ? store.profiles : null;
  return {
    id,
    version,
    keys: Object.keys(data),
    hasStore: Object.prototype.hasOwnProperty.call(data, 'qf.stored.v1'),
    schema: typeof store?.version === 'number' ? store.version : null,
    profilesCount: profiles?.length ?? null,
    validProfilesCount: profiles?.filter(isProfile).length ?? null,
    loginCount:
      profiles?.filter((p) => p && typeof p === 'object' && p.kind === 'login')
        .length ?? null,
    identityCount:
      profiles?.filter(
        (p) => p && typeof p === 'object' && p.kind === 'identity',
      ).length ?? null,
    blacklistCount: Array.isArray(store?.blacklist)
      ? store.blacklist.length
      : null,
    generationPresent: Object.prototype.hasOwnProperty.call(
      data,
      'qf.generation',
    ),
  };
}

export type SelfStatus = {
  installType:
    'admin' | 'development' | 'normal' | 'sideload' | 'other' | 'unknown';
  enabled: boolean | 'unknown';
  disabledReason: 'permissions_increase' | 'unknown';
  isOnToolbar: boolean | 'unknown';
};

/** Query this extension only. These calls need no broad management permission. */
export async function readSelfStatus(): Promise<SelfStatus> {
  const status: SelfStatus = {
    installType: 'unknown',
    enabled: 'unknown',
    disabledReason: 'unknown',
    isOnToolbar: 'unknown',
  };
  const self = async () => await chrome.management?.getSelf?.();
  const toolbar = async () => await chrome.action?.getUserSettings?.();
  const [selfResult, toolbarResult] = await Promise.allSettled([
    self(),
    toolbar(),
  ]);
  if (
    selfResult.status === 'fulfilled' &&
    selfResult.value &&
    typeof selfResult.value === 'object'
  ) {
    const info = selfResult.value;
    const installType = (
      ['admin', 'development', 'normal', 'sideload', 'other'] as const
    ).find((type) => type === info.installType);
    if (installType) status.installType = installType;
    if (typeof info.enabled === 'boolean') status.enabled = info.enabled;
    if (info.disabledReason === 'permissions_increase')
      status.disabledReason = 'permissions_increase';
  }
  if (
    toolbarResult.status === 'fulfilled' &&
    typeof toolbarResult.value?.isOnToolbar === 'boolean'
  ) {
    status.isOnToolbar = toolbarResult.value.isOnToolbar;
  }
  return status;
}
