import { detectField, parseAutocomplete } from './heuristics';
import { isVisible } from './visibility';

const BOUNDARY = 'form,[role="form"],fieldset';
const ACTION = 'button,input[type="submit"],input[type="button"],[role="button"]';
const MAX_ANCESTORS = 6;
const AUXILIARY_ACTION = /\b(show|hide|reveal|toggle|forgot|forgotten|recover|reset|cancel|back|help|support|eye|clear|remove|close|dismiss)\b|显示|隐藏|忘记|重置|取消|返回|帮助|清除|关闭/i;
const OTHER_ACTION = /\b(subscribe|newsletter|register)\b|sign\s*up|create\s+(?:an?\s+)?account|注册/i;
type ActionKind = 'authentication' | 'generic' | 'icon';

function currentDocument(el: HTMLElement): boolean {
  return el.ownerDocument === document && el.isConnected && window.top === window.self;
}

function owner(el: HTMLElement): HTMLFormElement | null {
  if (el instanceof HTMLFormElement) return el;
  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement
    || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    || el instanceof HTMLFieldSetElement) return el.form;
  return el.closest('form');
}

function belongsTo(el: HTMLElement, scope: Element): boolean {
  const form = owner(el);
  if (scope instanceof HTMLFormElement) return form === scope;
  if (form || el.closest('form')) return false;
  return el.closest('[role="form"],fieldset') === (scope.matches('[role="form"],fieldset') ? scope : null);
}

function members(scope: Element, selector: string): HTMLElement[] {
  const elements = scope instanceof HTMLFormElement
    ? [...scope.elements, ...scope.querySelectorAll('[role="button"]')]
    : [scope, ...scope.querySelectorAll(selector)];
  return [...new Set(elements)].filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el.matches(selector) && belongsTo(el, scope));
}

function editable(el: HTMLInputElement): boolean {
  return currentDocument(el) && !el.disabled && !el.matches(':disabled') && !el.readOnly
    && !el.closest('[inert]') && isVisible(el)
    && ['text', 'email', 'tel', 'password'].includes(el.type);
}

function password(el: HTMLInputElement): boolean {
  const token = detectField(el);
  return token === 'current-password' || token === 'new-password';
}

function account(el: HTMLInputElement): boolean {
  return el.type !== 'password' && ['username', 'email', 'tel'].includes(detectField(el) ?? '');
}

function inputs(scope: Element): HTMLInputElement[] {
  return members(scope, 'input').filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
}

function availableAction(button: HTMLElement): boolean {
  return !(!currentDocument(button) || !button.matches(ACTION) || !isVisible(button)
    || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true'
    || button.closest('[inert]') || button.hasAttribute('aria-pressed')
    || button.getAttribute('aria-haspopup') === 'true'
    || button.getAttribute('type')?.toLowerCase() === 'reset');
}

function actionText(button: HTMLElement): string {
  return (button.getAttribute('aria-label')?.trim() || button.textContent?.trim()
    || button.getAttribute('value')?.trim() || button.title).replace(/\s+/g, ' ');
}

function actionDescription(button: HTMLElement): string {
  return `${actionText(button)} ${button.id} ${button.className} ${button.getAttribute('name') ?? ''}`.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function actionKind(button: HTMLElement): ActionKind | null {
  if (!availableAction(button)) return null;
  const text = actionText(button);
  const description = actionDescription(button);
  if (AUXILIARY_ACTION.test(description) || OTHER_ACTION.test(description)) return null;
  const controlled = button.getAttribute('aria-controls')?.split(/\s+/)
    .map(id => document.getElementById(id));
  if (controlled?.some(el => el instanceof HTMLInputElement && (el.type === 'password' || password(el)))) return null;
  if (/\b(log\s*in|sign\s*in|authenticate)\b|登录|登入/i.test(text)) return 'authentication';
  if (/^(connexion|ログイン|iniciar sesi[oó]n)[\s.!→›»]*$/i.test(text)) return 'authentication';
  if (/^(continue|next|submit|go|proceed|继续|下一步|确认|提交)[\s.!→›»]*$/i.test(text)) return 'generic';
  if (!text && button.querySelector('svg,img,i,[data-icon]')) {
    // A nameless icon immediately beside the password is normally its reveal
    // toggle. A primary icon in its own action wrapper can still qualify.
    const siblings = button.parentElement?.querySelectorAll<HTMLInputElement>('input') ?? [];
    if (Array.from(siblings).some(field => field.type === 'password')
      && !Array.from(siblings).some(account)) return null;
    return 'icon';
  }
  if (owner(button) && (button instanceof HTMLButtonElement || button instanceof HTMLInputElement)
    && button.type === 'submit') return 'generic';
  return null;
}

function actions(scope: Element): HTMLElement[] {
  return members(scope, ACTION).filter(button => actionKind(button) !== null);
}

function hasWidgetAction(scope: Element): boolean {
  // A subscription/contact widget owns its account-looking field even though
  // its primary action cannot supply authentication intent.
  return members(scope, ACTION).some(button => availableAction(button)
    && !AUXILIARY_ACTION.test(actionDescription(button))
    && (actionKind(button) !== null || actionText(button) !== ''));
}

/** Authentication alone may join nested field/action wrappers. Identity filling
 * continues to use form-policy's narrower scope. No body/document-wide search. */
export function authenticationScope(anchor: HTMLElement): Element {
  if (!currentDocument(anchor)) return anchor;
  const form = owner(anchor);
  if (form) return form;
  const explicit = anchor.closest('[role="form"],fieldset');
  if (explicit && explicit !== document.body && explicit !== document.documentElement) return explicit;
  const component = anchor.closest('section,article,dialog,[role="dialog"],[role="region"]');
  let paired: Element | null = null;
  let parent = anchor.parentElement;
  for (let depth = 0; parent && depth < MAX_ANCESTORS; depth++, parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) break;
    if (component && !component.contains(parent)) break;
    // A broader ancestor containing another declared form is not evidence that
    // its controls belong to this formless login widget.
    if (parent.querySelector(BOUNDARY)) break;
    const fields = inputs(parent).filter(editable);
    const passwords = inputs(parent).filter(field => isVisible(field) && (field.type === 'password' || password(field)));
    const accounts = fields.filter(account);
    const primary = actions(parent);
    if (!passwords.length && accounts.length > 0 && hasWidgetAction(parent)) return parent;
    if (accounts.length > 1 || primary.length > 1) break;
    if (!passwords.length) continue;
    // A sibling password widget that already owns an action is a separate
    // component, not confirmation-password evidence for this anchor.
    if (passwords.length > 1 && Array.from(parent.children).some(child =>
      !child.contains(anchor) && inputs(child).some(field => isVisible(field) && field.type === 'password')
      && actions(child).length > 0)) break;
    if (Array.from(parent.children).some(child => !child.contains(anchor)
      && inputs(child).some(field => editable(field) && account(field))
      && hasWidgetAction(child))) break;
    if (accounts.length === 1 || passwords.length >= 2) paired ??= parent;
    // Once this password widget has an action, stop. A generic action lacking
    // a local account cannot become credible by borrowing a sibling's email.
    if (hasWidgetAction(parent)) return parent;
  }
  return paired ?? anchor;
}

/** Visible, editable recognized authentication controls only. OTP and malformed
 * password intent fail closed; account-only components are not credential sets. */
export function authenticationFields(anchor: HTMLElement): HTMLInputElement[] {
  if (!currentDocument(anchor)) return [];
  const fields = inputs(authenticationScope(anchor)).filter(editable);
  if (fields.some(field => /\bone-time-code\b/i.test(field.autocomplete)
    || (field.type === 'password' && !password(field)))) return [];
  if (!fields.some(password)) return [];
  return fields.filter(field => password(field) || account(field));
}

export function isAuthenticationSignupLike(anchor: HTMLElement): boolean {
  if (!currentDocument(anchor)) return false;
  const fields = inputs(authenticationScope(anchor));
  return fields.some(field => detectField(field) === 'new-password')
    || fields.filter(field => isVisible(field) && field.type === 'password').length >= 2;
}

export function isAuthenticationTrigger(button: HTMLElement, anchor: HTMLInputElement): boolean {
  if (!currentDocument(anchor) || !editable(anchor) || actionKind(button) === null
    || isAuthenticationSignupLike(anchor)) return false;
  const fields = authenticationFields(anchor);
  if (!fields.includes(anchor) || !fields.some(password)) return false;
  const scope = authenticationScope(anchor);
  if (!(scope instanceof HTMLFormElement) && !scope.matches('[role="form"],fieldset')
    && !fields.some(account) && actionKind(button) !== 'authentication') return false;
  const primary = actions(scope);
  // An unrecognized neighboring action makes a scripted submit ambiguous.
  // Known reveal/cancel/registration helpers remain excluded as before.
  const unknown = members(scope, ACTION).some(action => availableAction(action)
    && actionText(action) !== '' && actionKind(action) === null
    && !AUXILIARY_ACTION.test(actionDescription(action)) && !OTHER_ACTION.test(actionDescription(action)));
  return !unknown && primary.length === 1 && primary[0] === button;
}

/** Enter is an extra SPA intent signal only for a complete semantic credential
 * pair and its one local login action. Native forms must emit submit instead. */
export function isAuthenticationEnterTarget(anchor: HTMLInputElement): boolean {
  if (owner(anchor) || anchor.closest('form') || !editable(anchor) || !anchor.value
    || parseAutocomplete(anchor.autocomplete) !== 'current-password'
    || isAuthenticationSignupLike(anchor)) return false;
  const fields = authenticationFields(anchor);
  if (fields.length !== 2 || !fields.includes(anchor)
    || fields.filter(password).length !== 1
    || fields.filter(field => account(field) && !!field.value.trim()).length !== 1) return false;
  const primary = actions(authenticationScope(anchor));
  return primary.length === 1 && isAuthenticationTrigger(primary[0]!, anchor);
}
