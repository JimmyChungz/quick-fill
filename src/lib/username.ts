/**
 * The username input that belongs with a password field.
 *
 * There used to be two near-identical copies of this (one per call site, with a
 * subtly different signature). They were behaviourally equivalent — verified
 * against five form shapes — so this is the single definition now. `exclude` is
 * optional because the capture path sometimes has no password element to exclude
 * (it re-reads a form it already owns).
 */
import { isVisible } from './visibility';

export function findUsername(
  scope: ParentNode,
  exclude?: HTMLInputElement | null,
): HTMLInputElement | null {
  const all = (
    scope instanceof HTMLFormElement
      ? Array.from(scope.elements).filter(
          (el): el is HTMLInputElement =>
            el instanceof HTMLInputElement && el.form === scope,
        )
      : Array.from(
          scope.querySelectorAll<HTMLInputElement>(
            'input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=image]):not([type=file])',
          ),
        )
  ).filter(
    (i) =>
      i !== (exclude ?? null) &&
      ['text', 'search', 'email', 'tel', 'url'].includes(i.type) &&
      !i.disabled &&
      !i.readOnly &&
      isVisible(i),
  );
  return (
    all.find((i) => i.type === 'email') ??
    all.find(
      (i) => i.autocomplete === 'username' || i.autocomplete === 'email',
    ) ??
    all.find((i) =>
      /user.?name|^login$|login.?id|^email$/i.test(
        `${i.name} ${i.id} ${i.placeholder}`,
      ),
    ) ??
    all[0] ??
    null
  );
}
