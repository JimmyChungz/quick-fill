export type TraceEvent =
  | 'content_injected' | 'focus_detected' | 'field_classified'
  | 'capture_begin_sent' | 'capture_begin_ack' | 'capture_begin_error'
  | 'submit_intent_detected' | 'candidate_present'
  | 'pending_put_sent' | 'pending_put_ack' | 'pending_put_error'
  | 'save_click' | 'pending_save_sent' | 'pending_save_ack' | 'pending_save_error'
  | 'prompt_skipped' | 'banner_shown' | 'banner_hidden' | 'replay_attempt' | 'replay_result';

export type TraceReason =
  | 'no-password' | 'signup' | 'unsupported-scope' | 'blacklisted' | 'unchanged'
  | 'duplicate' | 'storage-error' | 'stale' | 'none' | 'shown' | 'acknowledged'
  | 'native-submit' | 'auth-button' | 'formless-enter';

export type CaptureTraceDetails = {
  operationId?: string;
  reason?: TraceReason;
  hasUsername?: boolean;
  hasPassword?: boolean;
  fieldCount?: number;
};
export type CaptureTraceEntry = CaptureTraceDetails & { timestamp: number; event: TraceEvent };

export const CAPTURE_TRACE_LIMIT = 100;
const events = new Set<TraceEvent>([
  'content_injected', 'focus_detected', 'field_classified',
  'capture_begin_sent', 'capture_begin_ack', 'capture_begin_error',
  'submit_intent_detected', 'candidate_present',
  'pending_put_sent', 'pending_put_ack', 'pending_put_error',
  'save_click', 'pending_save_sent', 'pending_save_ack', 'pending_save_error',
  'prompt_skipped', 'banner_shown', 'banner_hidden', 'replay_attempt', 'replay_result',
]);
const reasons = new Set<TraceReason>([
  'no-password', 'signup', 'unsupported-scope', 'blacklisted', 'unchanged',
  'duplicate', 'storage-error', 'stale', 'none', 'shown', 'acknowledged', 'native-submit', 'auth-button', 'formless-enter',
]);
let enabled = false;
const entries: CaptureTraceEntry[] = [];

/** Only finite state, presence flags, counts and operation IDs cross this boundary. */
export function sanitizeCaptureTrace(event: unknown, details: unknown): CaptureTraceEntry | null {
  if (typeof event !== 'string' || !events.has(event as TraceEvent)) return null;
  const entry: CaptureTraceEntry = { timestamp: Date.now(), event: event as TraceEvent };
  if (!details || typeof details !== 'object' || Array.isArray(details)) return entry;
  // Inspect own data properties only; an unexpected getter must not run in the capture pipeline.
  const value = (key: keyof CaptureTraceDetails): unknown => Object.getOwnPropertyDescriptor(details, key)?.value;
  const operationId = value('operationId');
  if (typeof operationId === 'string' && operationId.length >= 1 && operationId.length <= 128 && !/[^a-zA-Z0-9-]/.test(operationId)) {
    entry.operationId = operationId;
  }
  const reason = value('reason');
  if (typeof reason === 'string' && reasons.has(reason as TraceReason)) entry.reason = reason as TraceReason;
  const hasUsername = value('hasUsername');
  if (typeof hasUsername === 'boolean') entry.hasUsername = hasUsername;
  const hasPassword = value('hasPassword');
  if (typeof hasPassword === 'boolean') entry.hasPassword = hasPassword;
  const fieldCount = value('fieldCount');
  if (typeof fieldCount === 'number' && Number.isSafeInteger(fieldCount) && fieldCount >= 0) entry.fieldCount = Math.min(fieldCount, 1000);
  return entry;
}

export function setCaptureTraceEnabled(next: boolean): void {
  enabled = next === true;
  if (!enabled) entries.length = 0;
}

export function captureTrace(event: TraceEvent, details?: CaptureTraceDetails): void {
  if (!enabled) return;
  const entry = sanitizeCaptureTrace(event, details);
  if (!entry) return;
  entries.push(entry);
  if (entries.length > CAPTURE_TRACE_LIMIT) entries.shift();
}

export function readCaptureTrace(): CaptureTraceEntry[] {
  return entries.map(entry => ({ ...entry }));
}
