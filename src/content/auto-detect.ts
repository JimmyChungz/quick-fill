import type { FieldToken } from '../lib/types';
import { detectField as detectFieldRaw } from '../lib/heuristics';

export type DetectedField = { el: HTMLElement; token: FieldToken };

const FORM_SELECTOR = 'input, textarea, select';

function isFormControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

export function detectField(el: Element): FieldToken | null {
  if (!isFormControl(el)) return null;
  return detectFieldRaw(el);
}

export function scanFields(root: ParentNode = document): DetectedField[] {
  const out: DetectedField[] = [];
  for (const el of root.querySelectorAll(FORM_SELECTOR)) {
    if (!isFormControl(el)) continue;
    const t = detectFieldRaw(el);
    if (t) out.push({ el, token: t });
  }
  return out;
}

export function isPasswordField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === 'password') return true;
  const t = detectFieldRaw(el);
  return t === 'current-password' || t === 'new-password';
}
