import {attachInlineUnlock} from './inline-unlock';
import { initializeCaptureTrace, traceCapture } from './trace-client';
import { authenticationScope, authenticationFields, isAuthenticationSignupLike } from '../lib/auth-context';
import { detectField, isPasswordField, type DetectedField } from './auto-detect';
import { fillIdentity, fillValue, isWritable } from './fill';
import { Suggest } from './suggest';
import {
  attachCapture, recordPasswordFocus, recordCredentialFocus, trackInput, clearPending, flushPendingBanner,
} from './capture';
import { findUsername } from '../lib/username';
import { scopedFields, isSignupLike } from '../lib/form-policy';
import { send, currentGeneration } from '../lib/messaging';
import { debug } from '../lib/debug';
import type { LoginProfile, IdentityProfile, Profile, FieldToken } from '../lib/types';

debug('content: script loaded', { origin: window.location.origin });

const suggest = new Suggest();
const origin = window.location.origin;

const NON_LOGIN_TOKENS = new Set<FieldToken>(['username', 'current-password', 'new-password']);

/** Fields a profile could actually write into right now. */
const writableEmptyFields = (fields: DetectedField[]): DetectedField[] =>
  fields.filter((f) =>
    (f.el instanceof HTMLInputElement || f.el instanceof HTMLTextAreaElement)
    && isWritable(f.el)
    && f.el.value === '');

/** Most recently used first; legacy records fall back to their content time. */
const byRecency = <P extends { updatedAt: number; lastUsedAt?: number }>(arr: P[]): P[] =>
  arr.slice().sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));

/**
 * Identities that can actually put something on this form, with the number of
 * fields they would really write.
 *
 * The count is taken over *empty, writable* fields (not merely matching tokens)
 * so the label is a truthful promise: a field the user has already typed into
 * will be skipped by `fillIdentity` (N1), and counting it would leave the user
 * wondering why "可填 2/2" only wrote one value.
 */
function fillableIdentities(
  identities: IdentityProfile[],
  candidates: DetectedField[],
): Array<{ id: IdentityProfile; overlap: FieldToken[] }> {
  const keys = new Set<FieldToken>(writableEmptyFields(candidates).map((f) => f.token));
  return byRecency(identities)
    .map((id) => ({
      id,
      overlap: (Object.keys(id.fields) as FieldToken[]).filter((k) => keys.has(k)),
    }))
    .filter((x) => x.overlap.length > 0);
}

/** Re-scan only controls owned by the focused field's form/container. */
const identityCandidates = (anchor: HTMLElement): DetectedField[] =>
  scopedFields(anchor).flatMap(el => { const token = detectField(el); return token && !NON_LOGIN_TOKENS.has(token) ? [{el, token}] : []; });

type Cache = { logins: LoginProfile[]; identities: IdentityProfile[] };
let cache: Cache = { logins: [], identities: [] };
let refreshRevision = 0;
let authorizationEpoch = 0;
let knownGeneration = currentGeneration();

async function refresh(): Promise<void> {
  const revision = ++refreshRevision;
  debug('content: refresh() start');
  try {
    const res = await send({ type: 'qf.content_profiles' });
    if (revision !== refreshRevision) return;
    knownGeneration = currentGeneration();
    if (res && typeof res === 'object' && 'profiles' in res) {
      const profiles = (res as { profiles: Profile[] }).profiles;
      cache = {
        logins: byRecency(profiles.filter((p): p is LoginProfile => p.kind === 'login')),
        identities: byRecency(profiles.filter((p): p is IdentityProfile => p.kind === 'identity')),
      };
      debug('content: profile cache refreshed', {
        logins: cache.logins.length,
        identities: cache.identities.length,
      });
    }
  } catch (e) {
    if (revision === refreshRevision) cache = { logins: [], identities: [] };
    debug('content: refresh failed (SW may be inactive)', String(e));
    return;
  }
  debug('content: refresh() ok', { matches: cache.logins.filter((p) => p.url === origin).length });
}

async function fillSelection(id: string, anchor: HTMLInputElement | HTMLTextAreaElement, generation: string, use: (profile: Profile) => void): Promise<void> {
  const epoch = authorizationEpoch;
  try {
    const response = await send({ type: 'qf.fill_profile', id, generation }) as { profile?: Profile };
    if (epoch !== authorizationEpoch || generation !== currentGeneration() || !anchor.isConnected ||
        !isWritable(anchor) || isSignupLike(anchor) || isAuthenticationSignupLike(anchor)) return;
    if (response.profile?.id === id) use(response.profile);
  } catch { suggest.hide(); }
}

attachInlineUnlock(async () => {
 await refresh();
 const active=document.activeElement;
 if(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)active.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
});
void initializeCaptureTrace();
attachCapture();
void flushPendingBanner();
// The first user focus can precede the worker's initial metadata response.
// Re-evaluate only a still-focused field; ordinary later updates do not re-open UI.
void refresh().then(() => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    active.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'qf.data_changed' || typeof message.generation !== 'string' || typeof message.locked !== 'boolean') return;
  const invalidated = message.generation !== knownGeneration || message.locked;
  if (invalidated) authorizationEpoch++;
  knownGeneration = message.generation;
  refreshRevision++;
  cache = { logins: [], identities: [] };
  suggest.hide();
  // Ordinary saves in other tabs refresh suggestions without cancelling this
  // tab's independent capture. Lock/replacement still discards all secrets.
  if (invalidated) clearPending();
  if (!message.locked) void refresh();
});

document.addEventListener('focusin', (ev) => {
  const el = ev.target as Element;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;

  if (!isWritable(el) || (isSignupLike(el) || isAuthenticationSignupLike(el))) { suggest.hide(); clearPending(); return; }
  const generation = currentGeneration();
  const token = detectField(el);
  traceCapture('field_classified', {fieldCount:token ? 1 : 0});
  const label = el.getAttribute('data-qf')
    ?? (el.id || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName);
  if (!token) {
    debug(`content: focusin ${label} → (null) — no popup`);
    return;
  }
  // v2 audit (N5): only scan once, and only after we know we need the result.
  // The previous version scanned the whole document to log a count *before* the
  // token gate — on a 1000-input page that is ~4000 attribute reads for a focus
  // event we then ignore. The scope is the focused field's own form, which is
  // also the only place a "will this identity fill anything here?" question is
  // meaningful.
  const fieldsNow = identityCandidates(el);
  debug(`content: focusin ${label} → ${token} fields=${fieldsNow.length}`);

  // Login-token fields: username / email / tel / password. All trigger login suggestions AND set pending capture.
  const isLoginToken = token === 'username' || token === 'email' || token === 'tel'
    || token === 'current-password' || token === 'new-password'
    || (el instanceof HTMLInputElement && el.type === 'password');
  if (isLoginToken) {
    const matches = byRecency(cache.logins).filter((p) => p.url === origin);
    debug('content: credential focus', { token, origin, logins: matches.length, identities: cache.identities.length });

    const items: import('./suggest').MixedItem[] = [];
    for (const p of matches) {
      items.push({
        label: p.username || '(空用户名)',
        sub: p.url,
        badge: 'login',
        onPick: () => {
          if (!el.isConnected || (isSignupLike(el) || isAuthenticationSignupLike(el))) return;
          void fillSelection(p.id, el, generation, selected => {
            if (selected.kind !== 'login' || selected.url !== origin) return;
            const pickScope = authenticationScope(el);
            const focusedIsPassword = token === 'current-password' || token === 'new-password'
              || (el instanceof HTMLInputElement && el.type === 'password');
            if (focusedIsPassword) {
              const u = el instanceof HTMLInputElement ? findUsername(pickScope, el) : null;
              if (u) fillValue(u, selected.username);
              if (!el.value) fillValue(el, selected.password);
            } else {
              // Picked from the account field itself, so fill THAT field.
              // (findUsername deliberately excludes the element it is given —
              // handing it the focused username box left it with no candidate and
              // filled nothing at all.)
              fillValue(el, selected.username);
              const pw = authenticationFields(el).find(x => isPasswordField(x) && isWritable(x));
              // never clobber a password the user already typed
              if (pw && !pw.value) fillValue(pw, selected.password);
            }
            clearPending();
          });
        },
      });
    }
    // v2 audit (N10): an identity with nothing to write on the current form was
    // still listed; clicking it was a no-op, which read as "click does nothing".
    // The count is over empty+writable fields, so the label matches what will
    // really be written. Also sorted by recency (N7).
    for (const { id, overlap } of fillableIdentities(cache.identities, fieldsNow)) {
      items.push({
        label: id.label || '(未命名身份)',
        sub: `可填 ${overlap.length}/${Object.keys(id.fields).length}`,
        badge: 'identity',
        onPick: () => {
          // Re-check ownership and policy at click time, after dynamic DOM changes.
          if ((isSignupLike(el) || isAuthenticationSignupLike(el))) return;
          void fillSelection(id.id, el, generation, selected => {
            if (selected.kind === 'identity') fillIdentity(selected, identityCandidates(el));
          });
        },
      });
    }

    if (items.length > 0 && el instanceof HTMLElement) {
      suggest.show({ kind: 'mixed', target: el, items });
    }

    if (isPasswordField(el)) {
      recordPasswordFocus(el);
    } else if (el instanceof HTMLInputElement) {
      recordCredentialFocus(el);
    }
    return;
  }

  // v2 audit (N10): the non-login path (name/address/city/...) used to show
  // every stored identity regardless of whether any of its fields were on the
  // page at all.
  if (cache.identities.length === 0) return;
  const fillable = fillableIdentities(cache.identities, fieldsNow);
  if (fillable.length === 0) return;
  suggest.show({
    kind: 'identity',
    target: el,
    profiles: fillable.map((x) => x.id),
    fields: fieldsNow,
    doFill: (p) => {
      if ((isSignupLike(el) || isAuthenticationSignupLike(el))) return;
      void fillSelection(p.id, el, generation, selected => {
        if (selected.kind === 'identity') fillIdentity(selected, identityCandidates(el));
      });
      suggest.hide();
    },
  });
});

// Track input values for the capture pipeline (React/Vue may clear .value on re-render).
document.addEventListener('input', (ev) => {
  const target = ev.target;
  if (target instanceof HTMLElement) trackInput(target);
}, true);

document.addEventListener('mousedown', (e) => {
  // Bubble phase (false) so target handlers (popup item clicks) fire first.
  // composedPath covers shadow-DOM clicks — if the event is inside our popup,
  // don't hide it; otherwise hide.
  const host = suggest.getHost();
  if (host && e.composedPath().includes(host)) return;
  suggest.hide();
}, false);
