const DEFAULT_LOCAL_QUOTA = 10 * 1024 * 1024;
const CAPACITY_FRACTION = 0.8;
const encoder = new TextEncoder();

/** The candidate exceeded the reserved capacity before any storage write. */
export class StorageCapacityError extends Error {
  constructor() {
    super('密码库容量不足，未修改现有数据');
    this.name = 'StorageCapacityError';
  }
}

// JSON UTF-8 includes key quotes and punctuation, conservatively exceeding
// Chrome's JSON-value-plus-key-length accounting for each entry.
function estimateBytes(values: Record<string, unknown>): number {
  return encoder.encode(JSON.stringify(values)).byteLength;
}

/** Read-only preflight. Call before the first mutation of a compound write. */
export async function ensureLocalCapacity(updates: Record<string, unknown>): Promise<void> {
  const area = chrome.storage.local;
  const quota = Number.isFinite(area.QUOTA_BYTES) && area.QUOTA_BYTES > 0
    ? area.QUOTA_BYTES : DEFAULT_LOCAL_QUOTA;
  const keys = Object.keys(updates);
  let projected: number;
  if (typeof area.getBytesInUse === 'function') {
    const [used, replaced] = await Promise.all([
      area.getBytesInUse(null), area.getBytesInUse(keys),
    ]);
    if (!Number.isFinite(used) || !Number.isFinite(replaced) || used < 0 || replaced < 0 || replaced > used)
      throw Error('无法检查密码库容量，未修改现有数据');
    projected = used - replaced + estimateBytes(updates);
  } else {
    // Compatibility for older storage implementations and test harnesses.
    const current = await area.get(null);
    projected = estimateBytes({...current, ...updates});
  }
  if (projected > Math.floor(quota * CAPACITY_FRACTION))
    throw new StorageCapacityError();
}
