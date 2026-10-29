import { describe, it, expect, beforeEach } from 'vitest';
import { setValue, fillIdentity, isWritable } from '../src/content/fill';
import type { IdentityProfile } from '../src/lib/types';

describe('fill', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('writes value via native setter and dispatches input event', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    let inputFired = false;
    el.addEventListener('input', () => { inputFired = true; });
    expect(setValue(el, 'hello')).toBe(true);
    expect(el.value).toBe('hello');
    expect(inputFired).toBe(true);
  });

  it('skips disabled field', () => {
    const el = document.createElement('input');
    el.disabled = true;
    document.body.appendChild(el);
    expect(setValue(el, 'x')).toBe(false);
    expect(el.value).toBe('');
  });

  it('skips hidden field', () => {
    const el = document.createElement('input');
    el.type = 'hidden';
    document.body.appendChild(el);
    expect(setValue(el, 'x')).toBe(false);
  });

  it('skips readonly field', () => {
    const el = document.createElement('input');
    el.readOnly = true;
    document.body.appendChild(el);
    expect(setValue(el, 'x')).toBe(false);
  });

  it.each(['checkbox', 'radio', 'file', 'number', 'date', 'range', 'color', 'submit', 'button', 'reset'])('does not write %s controls', (type) => {
    const el = document.createElement('input');
    el.type = type;
    document.body.append(el);
    const before = el.value;
    expect(isWritable(el)).toBe(false);
    expect(setValue(el, 'secret')).toBe(false);
    expect(el.value).toBe(before);
  });

  it.each(['text', 'search', 'email', 'tel', 'url', 'password'])('allows visible connected %s controls', (type) => {
    const el = document.createElement('input');
    el.type = type;
    document.body.append(el);
    expect(setValue(el, 'hello')).toBe(true);
  });

  it('rejects disconnected controls and fields disabled by a fieldset', () => {
    const el = document.createElement('input');
    expect(setValue(el, 'secret')).toBe(false);
    document.body.innerHTML = '<fieldset disabled><input></fieldset>';
    expect(setValue(document.querySelector('input')!, 'secret')).toBe(false);
  });

  it.each(['display:none', 'visibility:hidden', 'opacity:0', 'content-visibility:hidden'])('rejects controls hidden by an ancestor (%s)', (style) => {
    document.body.innerHTML = `<div style="${style}"><input></div>`;
    expect(setValue(document.querySelector('input')!, 'secret')).toBe(false);
  });

  it('rejects controls in hidden or aria-hidden ancestors', () => {
    document.body.innerHTML = '<div hidden><input></div><div aria-hidden="true"><textarea></textarea></div>';
    expect(setValue(document.querySelector('input')!, 'secret')).toBe(false);
    expect(setValue(document.querySelector('textarea')!, 'secret')).toBe(false);
  });

  it('reports rejection when native input sanitization changes the value', () => {
    const el = document.createElement('input');
    el.type = 'email';
    document.body.append(el);
    expect(setValue(el, ' hello@example.com ')).toBe(false);
    expect(el.value).toBe('hello@example.com');
  });

  it('reports rejection when a controlled component reverts during input events', () => {
    const el = document.createElement('input');
    document.body.append(el);
    el.addEventListener('input', () => { el.value = ''; });
    expect(setValue(el, 'hello')).toBe(false);
  });
});

describe('fillIdentity (N1: respect already-typed values)', () => {
  const profile: IdentityProfile = {
    id: 'p', kind: 'identity', label: 'L',
    fields: { name: 'Alice', email: 'a@b.c', tel: '555' },
    updatedAt: 0,
  };

  it('writes to empty fields', () => {
    const a = document.createElement('input');
    const b = document.createElement('input');
    document.body.append(a, b);
    const summary = fillIdentity(profile, [
      { el: a, token: 'name' },
      { el: b, token: 'email' },
    ]);
    expect(summary.filled).toBe(2);
    expect(summary.skippedAlreadyTyped).toBe(0);
    expect(a.value).toBe('Alice');
    expect(b.value).toBe('a@b.c');
  });

  it('skips fields that already have a value (the v1.1 regression)', () => {
    const a = document.createElement('input'); a.value = 'already typed';
    const b = document.createElement('input');
    document.body.append(a, b);
    const summary = fillIdentity(profile, [
      { el: a, token: 'name' },
      { el: b, token: 'email' },
    ]);
    expect(summary.filled).toBe(1); // only b filled
    expect(summary.skippedAlreadyTyped).toBe(1);
    expect(a.value).toBe('already typed'); // NOT overwritten
    expect(b.value).toBe('a@b.c');
  });

  it('skips fields whose profile value is empty/null', () => {
    const sparse: IdentityProfile = { id: 'p', kind: 'identity', label: 'L', fields: { name: 'A' }, updatedAt: 0 };
    const a = document.createElement('input');
    const b = document.createElement('input');
    document.body.append(a, b);
    const summary = fillIdentity(sparse, [
      { el: a, token: 'name' },
      { el: b, token: 'email' },
    ]);
    expect(summary.filled).toBe(1);
    expect(summary.skippedNoValue).toBe(1);
  });

  it('overwriteAll opts back in to overwriting non-empty fields', () => {
    const a = document.createElement('input'); a.value = 'old';
    document.body.appendChild(a);
    const summary = fillIdentity(profile, [{ el: a, token: 'name' }], { overwriteAll: true });
    expect(summary.overwritten).toBe(1);
    expect(summary.filled).toBe(0);
    expect(a.value).toBe('Alice');
  });

  it('returns empty fields array → 0/0', () => {
    expect(fillIdentity(profile, [])).toMatchObject({ filled: 0, candidates: 0 });
  });
});

it('preserves legacy identity credential fields without using them to fill login fields', () => {
  const legacy = { id: 'legacy', kind: 'identity', label: 'Synthetic legacy', updatedAt: 1,
    fields: { username: 'synthetic-user', 'current-password': 'synthetic-old', 'new-password': 'synthetic-new', email: 'synthetic@example.test' } } as unknown as IdentityProfile;
  const user = document.createElement('input');
  const current = document.createElement('input'); current.type = 'password';
  const next = document.createElement('input'); next.type = 'password';
  const email = document.createElement('input'); email.type = 'email';
  document.body.append(user, current, next, email);
  expect(fillIdentity(legacy, [{ el: user, token: 'username' }, { el: current, token: 'current-password' }, { el: next, token: 'new-password' }, { el: email, token: 'email' }])).toMatchObject({ filled: 1, skippedNoValue: 3 });
  expect([user.value, current.value, next.value, email.value]).toEqual(['', '', '', 'synthetic@example.test']);
});
