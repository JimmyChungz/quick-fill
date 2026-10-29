import { send } from '../lib/messaging';
import { sanitizeCaptureTrace, type CaptureTraceDetails, type TraceEvent } from '../lib/capture-trace';

let enabled = false;
/** Enable only after the user explicitly starts a short diagnostic session. */
export async function initializeCaptureTrace(): Promise<void> {
  try {
    const result = await send({type:'qf.trace_status'}) as {enabled?: boolean};
    enabled = result.enabled === true;
    traceCapture('content_injected');
  } catch { enabled = false; }
}
export function traceCapture(event: TraceEvent, details?: CaptureTraceDetails): void {
  if (!enabled) return;
  const entry = sanitizeCaptureTrace(event, details);
  if (entry) void send({type:'qf.trace_event', event, details:entry}).catch(() => {});
}
