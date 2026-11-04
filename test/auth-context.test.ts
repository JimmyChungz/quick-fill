import { beforeEach, describe, expect, it } from 'vitest';
import {
  authenticationFields, authenticationScope,
  isAuthenticationSignupLike, isAuthenticationTrigger,
} from '../src/lib/auth-context';
import { fieldScope } from '../src/lib/form-policy';

const el = (id: string) => document.getElementById(id)!;
const input = (id: string) => el(id) as HTMLInputElement;
const ids = (anchor: string) => authenticationFields(el(anchor)).map(field => field.id);
const clickIntent = (button: string, anchor = 'p') => isAuthenticationTrigger(el(button), input(anchor));

function widget(action = '<button id="go" type="button">Continue</button>'): void {
  document.body.innerHTML = `<div id="auth"><div id="fields"><div><input id="u" autocomplete="username"></div><div><input id="p" type="password"></div></div><div>${action}</div></div>`;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('bounded authentication ownership', () => {
  it('groups nested sibling wrappers including a separate action wrapper', () => {
    widget();
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(authenticationScope(input('u'))).toBe(el('auth'));
    expect(ids('p')).toEqual(['u', 'p']);
    expect(clickIntent('go')).toBe(true);
    expect(fieldScope(input('p'))).toBe(input('p').parentElement);
  });

  it('uses the bounded credential component when no action is present', () => {
    widget('');
    expect(authenticationScope(input('p'))).toBe(el('fields'));
    expect(ids('p')).toEqual(['u', 'p']);
  });

  it('allows a coherent main element as a bounded login component', () => {
    document.body.innerHTML = '<main id="auth"><div><input id="u" autocomplete="username"></div><div><input id="p" type="password"></div><div><button id="go">Continue</button></div></main>';
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(clickIntent('go')).toBe(true);
  });

  it('supports password-only steps with an explicit local login action', () => {
    document.body.innerHTML = '<div id="auth"><div><input id="p" type="password"></div><div><button id="go">Sign in</button></div></div>';
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(clickIntent('go')).toBe(true);
  });

  it('does not infer an icon-only password step without an account field', () => {
    document.body.innerHTML = '<div><div><input id="p" type="password"></div><button id="go"><svg></svg></button></div>';
    expect(clickIntent('go')).toBe(false);
  });

  it('preserves native ownership including external associated inputs and buttons', () => {
    document.body.innerHTML = '<form id="auth"><div><input id="u" autocomplete="username"></div><input id="foreign" autocomplete="username" form="other"></form><form id="other"></form><input id="p" type="password" form="auth"><button id="go" type="button" form="auth">Continue</button><button id="wrong" form="other">Sign in</button><button id="unowned" type="button">Sign in</button>';
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(authenticationScope(el('go'))).toBe(el('auth'));
    expect(ids('p')).toEqual(['u', 'p']);
    expect(clickIntent('go')).toBe(true);
    expect(clickIntent('wrong')).toBe(false);
    expect(clickIntent('unowned')).toBe(false);
  });

  it.each(['role="form"', ''])('honors explicit form and fieldset boundaries (%s)', (role) => {
    document.body.innerHTML = role
      ? '<div role="form" id="auth"><div><input id="u" type="email"></div><div><input id="p" type="password"></div><button id="go">Next</button><div role="form"><input id="outside" type="email"><button id="wrong">Continue</button></div></div>'
      : '<fieldset id="auth"><div><input id="u" type="email"></div><div><input id="p" type="password"></div><button id="go">Next</button></fieldset><button id="wrong">Continue</button>';
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(ids('p')).toEqual(['u', 'p']);
    expect(clickIntent('go')).toBe(true);
    expect(clickIntent('wrong')).toBe(false);
  });

  it('does not absorb neighboring subscription or other authentication widgets', () => {
    widget();
    el('auth').insertAdjacentHTML('afterend', '<div><input id="subscription" type="email"><button id="subscribe">Subscribe</button></div><div><input id="other-user" autocomplete="username"><input id="other-password" type="password"><button id="other-login">Continue</button></div>');
    expect(ids('p')).toEqual(['u', 'p']);
    expect(clickIntent('go')).toBe(true);
    expect(clickIntent('subscribe')).toBe(false);
    expect(clickIntent('other-login')).toBe(false);
  });

  it('does not borrow a newsletter email for a password-only Continue widget', () => {
    document.body.innerHTML = '<main><section id="pw-widget"><input id="p" type="password"><button id="go" type="button">Continue</button></section><section id="newsletter"><input id="news" type="email" value="newsletter@example.test"><button id="subscribe">Subscribe</button></section></main>';
    expect(authenticationScope(input('p'))).toBe(el('pw-widget'));
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('go')).toBe(false);
    expect(authenticationScope(input('news'))).toBe(el('newsletter'));
    expect(ids('news')).toEqual([]);
    expect(clickIntent('go', 'news')).toBe(false);
  });

  it.each(['Subscribe', 'Join newsletter', 'Continue'])('treats an account-only %s widget as a boundary even without a local password action', (label) => {
    document.body.innerHTML = `<main><div><input id="p" type="password"></div><section id="newsletter"><div><input id="news" type="email"></div><div><button id="subscribe">${label}</button></div></section></main>`;
    expect(ids('p')).toEqual(['p']);
    expect(authenticationScope(input('news'))).toBe(el('newsletter'));
    expect(ids('news')).toEqual([]);
    expect(clickIntent('subscribe')).toBe(false);
    expect(clickIntent('subscribe', 'news')).toBe(false);
  });

  it('keeps legitimate sibling fields and action wrappers with an account clear helper', () => {
    widget();
    input('u').insertAdjacentHTML('afterend', '<button type="button" aria-label="Clear username"></button>');
    expect(authenticationScope(input('p'))).toBe(el('auth'));
    expect(ids('p')).toEqual(['u', 'p']);
    expect(clickIntent('go')).toBe(true);
  });

  it('does not join unrelated semantic sections even when neither has an action yet', () => {
    document.body.innerHTML = '<main><section><div><input id="p" type="password"></div></section><section><div><input id="news" type="email"></div></section></main>';
    expect(ids('p')).toEqual(['p']);
    expect(ids('news')).toEqual([]);
  });

  it('refuses a common ancestor merging two password widgets with their own actions', () => {
    document.body.innerHTML = '<main><div id="left"><input id="p" type="password"><button id="go">Sign in</button></div><div><input type="password"><button id="other">Sign in</button></div></main>';
    expect(authenticationScope(input('p'))).toBe(el('left'));
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('other')).toBe(false);
    expect(isAuthenticationSignupLike(input('p'))).toBe(false);
  });

  it('does not attach an orphan password to a neighboring complete password widget', () => {
    document.body.innerHTML = '<div id="outer"><div><input id="p" type="password"></div><div><input id="other-p" type="password"><button id="other">Sign in</button></div></div>';
    expect(authenticationScope(input('p'))).toBe(input('p'));
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('other')).toBe(false);
  });

  it('does not cross another native or role form to find a button', () => {
    document.body.innerHTML = '<div><div><input id="p" type="password"></div><form><input type="email"><button id="native">Sign in</button></form><div role="form"><button id="role">Sign in</button></div></div>';
    expect(clickIntent('native')).toBe(false);
    expect(clickIntent('role')).toBe(false);
  });

  it('never uses body/html as an authentication container', () => {
    document.body.innerHTML = '<input id="u" autocomplete="username"><input id="p" type="password"><button id="go">Sign in</button>';
    expect(authenticationScope(input('p'))).toBe(input('p'));
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('go')).toBe(false);
  });

  it('bounds the ancestor search depth', () => {
    document.body.innerHTML = '<div id="outer"><input id="u" autocomplete="username"><button id="go">Continue</button><div><div><div><div><div><div><div><input id="p" type="password"></div></div></div></div></div></div></div></div>';
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('go')).toBe(false);
  });
});

describe('authentication action semantics', () => {
  it.each(['Connexion', 'ログイン', 'Iniciar sesión'])('accepts the localized login action %s within one credential scope', (label) => {
    widget(`<button id="go" type="button">${label}</button>`);
    input('p').autocomplete = 'section-login current-password';
    expect(clickIntent('go')).toBe(true);
    expect(ids('go')).toEqual(['u', 'p']);
  });

  it.each(['Connexion', 'Continue'])('rejects %s when another unknown action makes intent ambiguous', (label) => {
    widget(`<button id="go" type="button">${label}</button><button id="other" type="button">Save draft</button>`);
    input('p').autocomplete = 'current-password';
    expect(clickIntent('go')).toBe(false);
  });

  it.each([
    '<button id="go">Next</button>',
    '<button id="go" aria-label="Continue"></button>',
    '<button id="go" aria-label="Continue">Continue</button>',
    '<button id="go" aria-label="Sign in"><svg></svg></button>',
    '<button id="go"><svg></svg></button>',
    '<span id="go" role="button" tabindex="0" aria-label="登录"></span>',
    '<input id="go" type="submit" value="Continue">',
  ])('accepts one plausible primary action in a credible component: %s', (action) => {
    widget(action);
    expect(clickIntent('go')).toBe(true);
  });

  it.each(['Show password', 'Hide password', 'Forgot password', 'Cancel', 'Back', 'Help', 'Reset password', 'Subscribe', 'Create account'])('excludes secondary action %s', (label) => {
    widget(`<button id="go">Continue</button><button id="secondary" type="button" aria-label="${label}"></button>`);
    expect(clickIntent('go')).toBe(true);
    expect(clickIntent('secondary')).toBe(false);
  });

  it('excludes an unlabeled reveal icon beside the password', () => {
    widget();
    input('p').insertAdjacentHTML('afterend', '<button id="eye" type="button"><svg></svg></button>');
    expect(clickIntent('eye')).toBe(false);
    expect(clickIntent('go')).toBe(true);
  });

  it('excludes a reveal icon identified by its class in a separate wrapper', () => {
    widget('<button id="go" class="show-password"><svg></svg></button>');
    expect(clickIntent('go')).toBe(false);
  });

  it('excludes toggle controls even with misleading primary labels', () => {
    widget('<button id="go">Continue</button><button id="eye" aria-pressed="false" aria-label="Continue"><svg></svg></button>');
    expect(clickIntent('eye')).toBe(false);
    expect(clickIntent('go')).toBe(true);
  });

  it('refuses multiple plausible primary actions in a formless component', () => {
    widget('<button id="go">Continue</button><button id="other">Next</button>');
    expect(clickIntent('go')).toBe(false);
    expect(clickIntent('other')).toBe(false);
  });

  it('refuses a generic action when multiple account fields make association ambiguous', () => {
    widget();
    el('fields').insertAdjacentHTML('beforeend', '<input id="newsletter" type="email">');
    expect(clickIntent('go')).toBe(false);
  });

  it('rejects disabled, hidden, non-button and detached triggers', () => {
    widget('<button id="go" disabled>Continue</button><button id="hidden" hidden>Continue</button><div id="plain">Continue</div>');
    expect(clickIntent('go')).toBe(false);
    expect(clickIntent('hidden')).toBe(false);
    expect(clickIntent('plain')).toBe(false);
    expect(isAuthenticationTrigger(document.createElement('button'), input('p'))).toBe(false);
  });
});

describe('authentication exclusions', () => {
  it.each(['new-password', 'section-login new-password webauthn'])('detects scoped %s registration intent', (autocomplete) => {
    widget();
    input('p').setAttribute('autocomplete', autocomplete);
    expect(isAuthenticationSignupLike(input('u'))).toBe(true);
    expect(clickIntent('go')).toBe(false);
  });

  it('recognizes two visible passwords across sibling wrappers as signup', () => {
    widget();
    el('fields').insertAdjacentHTML('beforeend', '<div><input id="confirm" type="password"></div>');
    expect(isAuthenticationSignupLike(input('p'))).toBe(true);
    expect(clickIntent('go')).toBe(false);
  });

  it('counts visible readonly password confirmations as a signup signal', () => {
    widget();
    el('fields').insertAdjacentHTML('beforeend', '<div><input type="password" readonly></div>');
    expect(isAuthenticationSignupLike(input('p'))).toBe(true);
    expect(clickIntent('go')).toBe(false);
  });

  it('recognizes a named new-password field', () => {
    widget();
    input('p').name = 'confirmPassword';
    expect(isAuthenticationSignupLike(input('u'))).toBe(true);
    expect(clickIntent('go')).toBe(false);
  });

  it('ignores hidden duplicate passwords and omits noneditable fields', () => {
    widget();
    el('fields').insertAdjacentHTML('beforeend', '<div hidden><input type="password"></div><input type="email" disabled><input type="email" readonly>');
    expect(ids('p')).toEqual(['u', 'p']);
    expect(isAuthenticationSignupLike(input('p'))).toBe(false);
    expect(clickIntent('go')).toBe(true);
  });

  it.each(['one-time-code', 'unknown current-password'])('does not treat unsupported password autocomplete %s as a credential', (autocomplete) => {
    widget();
    input('p').setAttribute('autocomplete', autocomplete);
    expect(ids('p')).toEqual([]);
    expect(clickIntent('go')).toBe(false);
  });

  it('does not capture an OTP component or unrelated unknown input', () => {
    widget();
    input('p').type = 'text';
    input('p').autocomplete = 'one-time-code';
    expect(ids('p')).toEqual([]);
    expect(clickIntent('go')).toBe(false);
  });

  it('does not include unknown controls as guessed account fields', () => {
    widget();
    input('u').removeAttribute('autocomplete');
    expect(ids('p')).toEqual(['p']);
    expect(clickIntent('go')).toBe(false);
  });

  it('does not read fields from iframe documents or disconnected widgets', () => {
    widget();
    const detached = input('p');
    el('auth').remove();
    expect(authenticationFields(detached)).toEqual([]);
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frame.contentDocument!.body.innerHTML = '<form><input type="password"></form>';
    const pw = frame.contentDocument!.querySelector('input')!;
    expect(authenticationFields(pw)).toEqual([]);
  });
});
