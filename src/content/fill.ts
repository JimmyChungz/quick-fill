import type { IdentityProfile } from '../lib/types';
import type { DetectedField } from './auto-detect';
import { isIdentityToken } from '../lib/tokens';
import { isVisible } from '../lib/visibility';

const INPUT_SETTER = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const TEXTAREA_SETTER = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

/**
 * Whether we are allowed to write into this control at all.
 * Exported so the popup can label an entry with the number of fields it will
 * ACTUALLY fill, instead of a token count that overpromises.
 */
export function isWritable(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (!el.isConnected || el.disabled || el.matches(':disabled') || el.readOnly || !isVisible(el)) return false;
  if (el instanceof HTMLInputElement && !['text', 'search', 'email', 'tel', 'url', 'password'].includes(el.type)) return false;
  // v1: top frame only
  if (window.top !== window.self) return false;
  return true;
}

export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  if (!isWritable(el)) return false;
  const setter = el instanceof HTMLTextAreaElement ? TEXTAREA_SETTER : INPUT_SETTER;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === value;
}

export type FillSummary = {
  /** Fields we actually wrote. Does NOT include `overwritten` — a field counted
   *  there was written too, so the total writes are filled + overwritten. */
  filled: number;
  /** Fields we looked at. */
  candidates: number;
  /** Profile had no value for this token — nothing to write. */
  skippedNoValue: number;
  /**
   * v2 audit (N1): the field already held a different value, so we refused to
   * clobber the user's own input. Higher means we respected more of the user's
   * typed values instead of overwriting them with a guess.
   */
  skippedAlreadyTyped: number;
  /** Caller passed `overwriteAll: true` and we did clobber a non-empty field. */
  overwritten: number;
};

/**
 * v2 audit (N1): the identity path used to unconditionally overwrite whatever
 * the user had already typed. That violates the product's "guesses can be
 * wrong, must be easy to correct" principle. Login fields are different —
 * filling a blank password input is the entire point — so `setValue` still
 * overwrites blanks. Everything else skips non-empty inputs.
 *
 * Pass `{ overwriteAll: true }` to opt back in (e.g. an explicit "覆盖" toggle
 * in the popup, if/when we add one).
 */
export function fillIdentity(
  profile: IdentityProfile,
  fields: DetectedField[],
  opts: { overwriteAll?: boolean } = {},
): FillSummary {
  const summary: FillSummary = {
    filled: 0, candidates: 0,
    skippedNoValue: 0, skippedAlreadyTyped: 0, overwritten: 0,
  };
  for (const { el, token } of fields) {
    summary.candidates++;
    if (!isIdentityToken(token)) { summary.skippedNoValue++; continue; }
    const v = profile.fields[token];
    if (v == null) { summary.skippedNoValue++; continue; }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
    const before = el.value;
    if (before !== '' && before !== v && !opts.overwriteAll) {
      summary.skippedAlreadyTyped++;
      continue;
    }
    if (setValue(el, v)) {
      if (before !== '' && opts.overwriteAll) summary.overwritten++;
      else summary.filled++;
    }
  }
  return summary;
}

export function fillValue(el: HTMLElement, value: string): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  return setValue(el, value);
}
