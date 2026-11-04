import { beforeEach, describe, expect, it } from 'vitest';
import { fieldScope, scopedFields, isSignupLike } from '../src/lib/form-policy';

beforeEach(() => { document.body.innerHTML = ''; });

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('form ownership and boundaries', () => {
  it('includes external form-associated controls and excludes controls owned by a different form', () => {
    document.body.innerHTML = '<form id="a"><input id="u"><input id="other" form="b"></form><form id="b"></form><input id="p" type="password" form="a">';
    expect(fieldScope(input('p'))).toBe(document.getElementById('a'));
    expect(scopedFields(input('u')).map(el => el.id)).toEqual(['u', 'p']);
    expect(scopedFields(input('other')).map(el => el.id)).toEqual(['other']);
  });

  it('uses the nearest explicit role=form or fieldset without crossing neighboring widgets', () => {
    document.body.innerHTML = '<div role="form" id="a"><div><input id="u"></div><input id="p"><fieldset id="inner"><input id="nested"></fieldset></div><div role="form"><input id="other"></div>';
    expect(fieldScope(input('u'))).toBe(document.getElementById('a'));
    expect(scopedFields(input('u')).map(el => el.id)).toEqual(['u', 'p']);
    expect(fieldScope(input('nested'))).toBe(document.getElementById('inner'));
  });

  it('bounds the fallback to its immediate container and does not absorb nested forms', () => {
    document.body.innerHTML = '<div id="container"><input id="u"><input id="p"><form><input id="nested"></form><div><input id="sibling-widget"></div></div><input id="outside">';
    expect(fieldScope(input('u'))).toBe(document.getElementById('container'));
    expect(scopedFields(input('u')).map(el => el.id)).toEqual(['u', 'p']);
  });

  it('does not create a document-wide or body-wide fallback', () => {
    document.body.innerHTML = '<input id="u"><input id="p" type="password">';
    expect(fieldScope(input('u'))).toBe(input('u'));
    expect(scopedFields(input('u'))).toEqual([input('u')]);
    const detached = document.createElement('input');
    expect(fieldScope(detached)).toBe(detached);
    expect(scopedFields(detached)).toEqual([detached]);
  });
});

describe('shared registration and password-change policy', () => {
  it('blocks identity fields as well as credential fields when the scoped form has two visible passwords', () => {
    document.body.innerHTML = '<form><input id="email" type="email"><input type="password"><input type="password"></form><form><input id="login" type="password"></form>';
    expect(isSignupLike(input('email'))).toBe(true);
    expect(isSignupLike(input('login'))).toBe(false);
  });

  it('ignores password duplicates hidden by ancestors', () => {
    document.body.innerHTML = '<form><input id="login" type="password"><div style="display:none"><input type="password"></div></form>';
    expect(isSignupLike(input('login'))).toBe(false);
  });

  it.each(['section-account new-password', 'new-password webauthn'])('blocks a scoped new-password signal (%s)', (autocomplete) => {
    document.body.innerHTML = `<form><input id="email" type="email"><input type="password" autocomplete="${autocomplete}"></form>`;
    expect(isSignupLike(input('email'))).toBe(true);
  });

  it('recognizes a named new-password field and includes external associated controls', () => {
    document.body.innerHTML = '<form id="a"><input id="email" type="email"></form><input type="password" name="confirmPassword" form="a">';
    expect(isSignupLike(input('email'))).toBe(true);
  });

  it('does not infer registration from unrelated page text or another form', () => {
    document.body.innerHTML = '<h1>Register now</h1><form><input id="login" type="password"></form><form><input type="password" autocomplete="new-password"></form>';
    expect(isSignupLike(input('login'))).toBe(false);
  });
});
