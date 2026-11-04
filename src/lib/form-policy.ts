import { detectField } from './heuristics';
import { isVisible } from './visibility';

function isControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Native ownership wins, including controls associated through form="id".
 * With no explicit form boundary, only the immediate container is trusted. */
export function fieldScope(el: HTMLElement): ParentNode {
  if (isControl(el) && el.form) return el.form;
  const explicit = el.closest('[role="form"], fieldset');
  if (explicit && explicit !== el.ownerDocument.body && explicit !== el.ownerDocument.documentElement) return explicit;
  const parent = el.parentElement;
  return parent && parent !== el.ownerDocument.body && parent !== el.ownerDocument.documentElement ? parent : el;
}

export function scopedFields(el: HTMLElement): HTMLElement[] {
  const scope = fieldScope(el);
  if (scope instanceof HTMLFormElement) {
    return Array.from(scope.elements).filter((field): field is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
      isControl(field) && field.form === scope);
  }
  const candidates = [
    ...(scope instanceof HTMLElement && isControl(scope) ? [scope] : []),
    ...scope.querySelectorAll('input, textarea, select'),
  ];
  return candidates.filter((field): field is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
    isControl(field) && !field.form && fieldScope(field) === scope);
}

/** The same conservative registration/change-password guard is used for every
 * suggestion and capture entry point, including focused identity fields. */
export function isSignupLike(el: HTMLElement): boolean {
  const fields = scopedFields(el);
  if (fields.some(field => detectField(field) === 'new-password')) return true;
  return fields.filter(field => field instanceof HTMLInputElement && field.type === 'password' && isVisible(field)).length >= 2;
}
