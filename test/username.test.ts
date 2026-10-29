// lib/username.ts used to hold two near-identical implementations
// (findUsernameInput + findUsername). Neither is a duplicate now: there is one
// function, and these cases pin the behaviour both old call sites relied on.
import { describe, it, expect, beforeEach } from 'vitest';
import { findUsername } from '../src/lib/username';

type Spec = Array<[type: string, name: string]>;

function buildForm(spec: Spec): { form: HTMLFormElement; pw: HTMLInputElement } {
  const form = document.createElement('form');
  for (const [type, name] of spec) {
    const el = document.createElement('input');
    el.type = type;
    el.name = name;
    form.appendChild(el);
  }
  document.body.appendChild(form);
  return { form, pw: form.querySelector('input[type=password]') as HTMLInputElement };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('findUsername', () => {
  it('is the only implementation left', async () => {
    const mod = await import('../src/lib/username');
    expect('findUsernameInput' in mod).toBe(false);
  });

  it('returns the username field and honours the optional exclude', () => {
    const { form, pw } = buildForm([['text', 'username'], ['password', 'password']]);
    expect(findUsername(form, pw)?.name).toBe('username');
    // the capture path calls it without an exclude
    expect(findUsername(form)?.name).toBe('username');
  });

  it('excludes the element it is given', () => {
    const { form, pw } = buildForm([['text', 'first'], ['text', 'second'], ['password', 'password']]);
    expect(findUsername(form, form.querySelector<HTMLInputElement>('input[name=first]'))?.name).toBe('second');
    void pw;
  });

  it('prefers type=email', () => {
    const { form, pw } = buildForm([['text', 'login'], ['email', 'email'], ['password', 'password']]);
    expect(findUsername(form, pw)?.name).toBe('email');
  });

  it('prefers an autocomplete=username hint over a plain field', () => {
    const { form, pw } = buildForm([['text', 'q'], ['text', 'u'], ['password', 'password']]);
    form.querySelector<HTMLInputElement>('input[name=u]')!.setAttribute('autocomplete', 'username');
    expect(findUsername(form, pw)?.name).toBe('u');
  });

  it('falls back to the first non-password input', () => {
    const { form, pw } = buildForm([['text', 'q'], ['password', 'password']]);
    expect(findUsername(form, pw)?.name).toBe('q');
  });

  it('never returns a password input, and returns null when there is nothing else', () => {
    const { form, pw } = buildForm([['password', 'password']]);
    expect(findUsername(form, pw)).toBeNull();
  });
});

describe('QF form ownership on username fill',()=>{
 it('uses external associated account and never another form owner',()=>{
  document.body.innerHTML='<form id="login"><input id="wrong" type="email" form="other"><input id="pw" type="password"></form><form id="other"></form><input id="right" autocomplete="username" form="login">';
  expect(findUsername(document.querySelector('#login')!,document.querySelector<HTMLInputElement>('#pw'))?.id).toBe('right');
 });
});
