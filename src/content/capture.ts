import { isVisible } from '../lib/visibility';
import { detectField } from '../lib/heuristics';
import { traceCapture } from './trace-client';
import { SaveBanner } from './save-banner';
import { authenticationScope, authenticationFields, isAuthenticationSignupLike, isAuthenticationTrigger, isAuthenticationEnterTarget } from '../lib/auth-context';
import { isWritable } from './fill';
import { send, currentGeneration } from '../lib/messaging';
import { newId } from '../lib/id';
import type { LoginProfile, PendingCredential } from '../lib/types';

export type Candidate = { origin: string; username: string; password: string };
export const PENDING_TTL_MS = 5 * 60 * 1000;
type Pending = {
  anchor: HTMLInputElement;
  id: string;
  generation: string;
  last: Candidate | null;
};
let pending: Pending | null = null,
  lastPromptKey: string | null = null;
const banner = new SaveBanner();
let detach: (() => void) | null = null;
let epoch = 0;
let displayAnchor: HTMLInputElement | null = null;
let usernameStep: {scope:Element; username:string; expiresAt:number; generation:string} | null = null;
let replayInFlight: Promise<'shown' | 'skipped' | 'none'> | null = null;
let replayAfterFlight: {epoch: number; revision: number} | null = null;

const credentialPassword = (el:HTMLInputElement): boolean => el.type === 'password' || detectField(el) === 'current-password';
function values(
  anchor: HTMLInputElement,
  fallback: Candidate | null = null,
): Candidate | null {
  if (!anchor.isConnected || isAuthenticationSignupLike(anchor)) return null;
  const fields = authenticationFields(anchor).filter(
    (x): x is HTMLInputElement =>
      x instanceof HTMLInputElement && isWritable(x),
  );
  const pw =
    credentialPassword(anchor) && fields.includes(anchor)
      ? anchor
      : fields.find(credentialPassword);
  if (!pw || !isWritable(pw)) return null;
  const candidates = fields.filter((x) => !credentialPassword(x));
  const user =
    candidates.find((x) => x.autocomplete.split(/\s+/).includes('username')) ??
    candidates.find((x) => x.type === 'email') ??
    candidates.find((x) => /user.?name|^login$|account/i.test(x.name || x.id));
  return {
    origin: location.origin,
    username: user?.value || fallback?.username || (usernameStep && usernameStep.scope === authenticationScope(anchor) && usernameStep.expiresAt > Date.now() && usernameStep.generation === currentGeneration() ? usernameStep.username : ''),
    password: pw.value || fallback?.password || '',
  };
}
function pageDisallowsPrompt(anchor:HTMLInputElement|null = displayAnchor): boolean {
  if (anchor?.isConnected) return isAuthenticationSignupLike(anchor);
  const passwords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"],input[autocomplete~="new-password"]'))
    .filter(isVisible);
  // A hidden or separate registration widget does not invalidate a real login.
  // With no surviving source scope, suppress replay on a signup-only page.
  return passwords.length > 0 && passwords.every(isAuthenticationSignupLike);
}
const candidateKey = (c: Candidate) =>
  `${c.origin}\0${c.username}\0${c.password}`;
async function promptNow(): Promise<void> {
  const captured = pending;
  if (!captured) return;
  const c = values(captured.anchor, captured.last);
  pending = null;
  usernameStep = null;
  traceCapture('candidate_present', {hasUsername:!!c?.username, hasPassword:!!c?.password});
  if (!c?.password || candidateKey(c) === lastPromptKey) {
    traceCapture('prompt_skipped', {reason:!c?.password ? 'no-password' : 'duplicate'});
    return;
  }
  const { id, generation } = captured;
  const submittedEpoch = ++epoch;
  // Dispatch the message synchronously in the submit handler. All asynchronous
  // reads/decisions belong to the worker, which survives source navigation.
  traceCapture('pending_put_sent', {operationId:id});
  const put = send({ type: 'qf.pending_put', candidate: c, id, generation });
  try {
    const res = (await put) as {
      pending: PendingCredential | null;
      existing?: LoginProfile;
      generation: string;
      reason?: 'blacklisted' | 'unchanged';
    };
    traceCapture('pending_put_ack', {operationId:id});
    if (!res.pending || submittedEpoch !== epoch || pageDisallowsPrompt(captured.anchor)) {
      traceCapture('prompt_skipped', {reason:submittedEpoch !== epoch ? 'stale' : pageDisallowsPrompt(captured.anchor) ? 'signup' : res.reason ?? 'none'});
      return;
    }
    lastPromptKey = candidateKey(c);
    displayAnchor = captured.anchor;
    banner.show({
      ...c,
      operationId: id,
      generation: res.generation,
      existing: res.existing,
    });
  } catch (err) {
    traceCapture('pending_put_error', {operationId:id, reason:'storage-error'});
    if (submittedEpoch !== epoch || pageDisallowsPrompt(captured.anchor)) return;
    displayAnchor = captured.anchor;
    banner.show({
      ...c,
      operationId: id,
      generation,
      needsPersist: true,
      error: err instanceof Error ? err.message : '保存准备失败，请重试',
    });
  }
}

// Multi-step association is deliberately document-local and requires the same
// declared form/role-form to survive. Never copy an account from another widget,
// another document, saved records, or a cross-origin SSO flow.
function rememberUsernameStep(target: HTMLElement): boolean {
  const scope = target instanceof HTMLFormElement ? target
    : target instanceof HTMLButtonElement || target instanceof HTMLInputElement
      ? target.form ?? target.closest('[role="form"],fieldset')
      : target.closest('[role="form"],fieldset');
  if (!scope || !scope.isConnected || isAuthenticationSignupLike(target)) return false;
  const all = scope instanceof HTMLFormElement ? Array.from(scope.elements) : Array.from(scope.querySelectorAll('input'));
  const fields = all.filter((el):el is HTMLInputElement => el instanceof HTMLInputElement && isWritable(el)
    && (scope instanceof HTMLFormElement ? el.form === scope : !el.form && el.closest('[role="form"],fieldset') === scope));
  if (fields.some(el => credentialPassword(el) || el.autocomplete.includes('one-time-code'))) return false;
  const accounts = fields.filter(el => el.autocomplete.split(/\s+/).includes('username'));
  if (accounts.length !== 1 || fields.length !== 1 || !accounts[0]!.value) return false;
  if (!(target instanceof HTMLFormElement)) {
    const label = (target.getAttribute('aria-label') || target.textContent || target.getAttribute('value') || '').trim();
    if (!/^(?:next|continue|log\s*in|sign\s*in|下一步|继续|登录|登入)[\s.!→›»]*$/i.test(label)
      || target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') return false;
  }
  usernameStep = {scope, username:accounts[0]!.value, expiresAt:Date.now()+2*60*1000, generation:currentGeneration()};
  return true;
}

export function attachCapture(): () => void {
  if (detach) return detach;
  // A focus event may have occurred before injection (autofocus/password
  // managers). Recover only from the actual submitted form or local auth button.
  const fromIntent = (target: HTMLElement): HTMLInputElement | null => {
    const fields = authenticationFields(target);
    const passwords = fields.filter(credentialPassword);
    return passwords.length === 1 ? passwords[0]! : null;
  };
  const submit = (ev: Event) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const form = target instanceof HTMLFormElement ? target
      : target instanceof HTMLInputElement ? target.form : null;
    if (!form) return;
    if (rememberUsernameStep(form)) return;
    if (!pending || pending.anchor.form !== form) {
      const anchor = fromIntent(form);
      if (!anchor) return;
      recordPasswordFocus(anchor);
    }
    if (pending?.anchor.form === form) { traceCapture('submit_intent_detected', {reason:'native-submit'}); void promptNow(); }
  };
  const click = (ev: MouseEvent) => {
    if (!(ev.target instanceof Element)) return;
    const button = ev.target.closest('button,input[type=submit],input[type=button],[role=button]');
    if (!(button instanceof HTMLElement)) return;
    // Native controls must pass browser validation and emit submit first.
    if ((button instanceof HTMLButtonElement || button instanceof HTMLInputElement)
      && button.type === 'submit' && button.form) return;
    if (rememberUsernameStep(button)) return;
    let anchor = pending?.anchor;
    if (!anchor || !isAuthenticationTrigger(button, anchor)) {
      anchor = fromIntent(button) ?? undefined;
      if (!anchor || !isAuthenticationTrigger(button, anchor)) return;
      recordPasswordFocus(anchor);
    }
    // A JS button may call requestSubmit(). Do not bypass native constraints
    // by capturing earlier in click capture phase. SPA forms using novalidate
    // deliberately opt out and remain eligible for the product's attempt rule.
    if (anchor.form && !anchor.form.noValidate && anchor.form.matches(':invalid')) return;
    traceCapture('submit_intent_detected', {reason:'auth-button'});
    void promptNow();
  };
  const keydown = (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || ev.repeat
      || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey
      || !(ev.target instanceof HTMLInputElement) || !isAuthenticationEnterTarget(ev.target)) return;
    if (pending?.anchor !== ev.target) recordPasswordFocus(ev.target);
    traceCapture('submit_intent_detected', {reason:'formless-enter'});
    void promptNow();
  };
  let scheduled = false;
  const replay = () => {
    if (scheduled || banner.isShown() || banner.isBusy()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!banner.isShown() && !banner.isBusy()) void flushPendingBanner();
    });
  };
  // DOM observation only repairs an existing detached prompt. A DOM mutation
  // never turns newly inserted passwords into credential candidates.
  const observer = new MutationObserver(() => {
    if (banner.isShown() && pageDisallowsPrompt()) banner.hide();
    else if (banner.hasDetachedHost()) replay();
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
  const navigation = (window as Window & {navigation?: EventTarget}).navigation;
  navigation?.addEventListener('currententrychange', replay);
  window.addEventListener('popstate', replay);
  window.addEventListener('hashchange', replay);
  document.addEventListener('submit', submit, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', keydown, true);
  detach = () => {
    observer.disconnect();
    navigation?.removeEventListener('currententrychange', replay);
    window.removeEventListener('popstate', replay);
    window.removeEventListener('hashchange', replay);
    document.removeEventListener('submit', submit, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', keydown, true);
    detach = null;
  };
  return detach;
}
export function recordPasswordFocus(
  el: HTMLInputElement | HTMLTextAreaElement,
): void {
  if (
    !(el instanceof HTMLInputElement) ||
    !isWritable(el) ||
    isAuthenticationSignupLike(el)
  ) {
    pending = null;
    return;
  }
  traceCapture('focus_detected');
  const id = newId();
  pending = {
    anchor: el,
    id,
    generation: currentGeneration(),
    last: values(el),
  };
  // Queue the generation binding before a possible immediate submit; a later
  // clear deletes this permit, so old documents cannot revive cleared data.
  traceCapture('capture_begin_sent', {operationId:id});
  void send({ type: 'qf.capture_begin', id }).then(() => traceCapture('capture_begin_ack', {operationId:id}), () => traceCapture('capture_begin_error', {operationId:id,reason:'storage-error'}));
}
export function recordCredentialFocus(
  el: HTMLInputElement | HTMLTextAreaElement,
): void {
  recordPasswordFocus(el);
}
export function trackInput(el: HTMLElement): void {
  if (
    !pending ||
    !(el instanceof HTMLInputElement) ||
    authenticationScope(el) !== authenticationScope(pending.anchor)
  )
    return;
  // Input events preserve the latest scoped user values before React/Vue clears
  // DOM values. An explicit user clear updates the snapshot to empty as well.
  pending.last = values(pending.anchor);
}
export function clearPending(): void {
  epoch++;
  replayAfterFlight = null;
  usernameStep = null;
  displayAnchor = null;
  pending = null;
  lastPromptKey = null;
  banner.hide();
}
export function flushPendingBanner(): Promise<'shown' | 'skipped' | 'none'> {
  if (banner.isShown() || banner.isBusy()) return Promise.resolve('none');
  if (replayInFlight) {
    if (banner.hasDetachedHost()) replayAfterFlight = {epoch, revision: banner.revision};
    return replayInFlight;
  }
  traceCapture('replay_attempt');
  const revision = banner.revision;
  const replayEpoch = epoch;
  const run = async (): Promise<'shown' | 'skipped' | 'none'> => {
    try {
      if (pageDisallowsPrompt()) return 'skipped';
      const res = await send({type:'qf.pending_get'}) as {pending:PendingCredential|null; existing?:LoginProfile; reason?:'blacklisted'|'unchanged'};
      const p = res.pending;
      if (!p || replayEpoch !== epoch || revision !== banner.revision) return res.reason ? 'skipped' : 'none';
      if (replayEpoch !== epoch || revision !== banner.revision || pageDisallowsPrompt()) return 'none';
      lastPromptKey = candidateKey(p);
      banner.show({...p, operationId:p.id, generation:p.generation, existing:res.existing});
      traceCapture('replay_result', {reason:'shown',operationId:p.id});
      return 'shown';
    } catch { return 'none'; }
  };
  replayInFlight = run().finally(async () => {
    replayInFlight = null;
    const request = replayAfterFlight;
    replayAfterFlight = null;
    // A navigation read may predate the banner that a later SPA render removes.
    // Refresh that stale snapshot once; missing/error results never poll.
    if (request && request.epoch === epoch && request.revision === banner.revision
      && (replayEpoch !== request.epoch || revision !== request.revision)
      && banner.hasDetachedHost()) await flushPendingBanner();
  });
  return replayInFlight;
}
export function _resetForTests(): void {
  epoch++;
  usernameStep = null;
  displayAnchor = null;
  replayInFlight = null;
  replayAfterFlight = null;
  pending = null;
  lastPromptKey = null;
  banner.hide();
}
