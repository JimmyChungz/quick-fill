import type { TraceEvent, CaptureTraceDetails } from './capture-trace';
export type FieldToken =
  | 'username'
  | 'current-password'
  | 'new-password'
  | 'given-name'
  | 'family-name'
  | 'name'
  | 'email'
  | 'tel'
  | 'organization'
  | 'street-address'
  | 'address-line1'
  | 'address-line2'
  | 'city'
  | 'region'
  | 'postal-code'
  | 'country';

export type IdentityToken = Exclude<
  FieldToken,
  'username' | 'current-password' | 'new-password'
>;

export type LoginProfile = {
  id: string;
  kind: 'login';
  url: string;
  username: string;
  password: string;
  updatedAt: number;
  /** Optional fill recency; updatedAt remains the content version. */
  lastUsedAt?: number;
};

export type IdentityProfile = {
  id: string;
  kind: 'identity';
  label: string;
  fields: Partial<Record<IdentityToken, string>>;
  updatedAt: number;
  /** Optional fill recency; updatedAt remains the content version. */
  lastUsedAt?: number;
};

export type Profile = LoginProfile | IdentityProfile;

export type Stored = {
  version: 1;
  profiles: Profile[];
  blacklist: string[];
};

export type ExportPayload = {
  version: 1;
  exportedAt: number;
  profiles: Profile[];
};

export type PendingCredential = {
  id: string;
  origin: string;
  username: string;
  password: string;
  createdAt: number;
  generation: string;
  tabId: number;
  targetId?: string;
  targetUpdatedAt?: number;
};

export type Message = (
  | { type: 'qf.unlock_prompt' }
  | { type: 'qf.inline_unlock_status'; nonce: string }
  | { type: 'qf.inline_unlock_submit'; nonce: string; password: string }
  | { type: 'qf.inline_unlock_cancel'; nonce: string }
  | { type: 'qf.trace_status' }
  | { type: 'qf.trace_read' }
  | { type: 'qf.trace_set'; enabled: boolean }
  | { type: 'qf.trace_event'; event: TraceEvent; details?: CaptureTraceDetails }
  | { type: 'qf.get_profiles' }
  | { type: 'qf.content_profiles' }
  | { type: 'qf.fill_profile'; id: string }
  | { type: 'qf.data_changed'; locked: boolean }
  | { type: 'qf.vault_status' }
  | { type: 'qf.vault_setup'; password: string }
  | { type: 'qf.vault_unlock'; password: string }
  | { type: 'qf.vault_lock' }
  | { type: 'qf.vault_change'; oldPassword: string; newPassword: string }
  | { type: 'qf.vault_export'; recovery?: boolean }
  | { type: 'qf.vault_restore'; envelope: unknown; password: string }
  | {
      type: 'qf.profiles';
      profiles: Profile[];
      imported?: number;
      rejected?: number;
    }
  | {
      type: 'qf.update_profile';
      profile: Profile;
      patch?: boolean;
      create?: boolean;
      expectedUpdatedAt?: number;
    }
  | { type: 'qf.touch_profile'; id: string }
  | { type: 'qf.clear_all' }
  | { type: 'qf.export_raw' }
  | { type: 'qf.capture_begin'; id: string }
  | { type: 'qf.remove_blacklist'; origin: string }
  | {
      type: 'qf.pending_put';
      candidate: { origin: string; username: string; password: string };
      id: string;
    }
  | { type: 'qf.pending_get' }
  | { type: 'qf.pending_drop'; id: string }
  | { type: 'qf.pending_save'; id: string }
  | { type: 'qf.pending_blacklist'; id: string }
  | { type: 'qf.delete_profile'; id: string }
  | { type: 'qf.add_blacklist'; origin: string }
  | { type: 'qf.export' }
  | { type: 'qf.import'; payload: ExportPayload }
  | { type: 'qf.error'; message: string }
) & { generation?: string };
