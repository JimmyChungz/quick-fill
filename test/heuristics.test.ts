import { describe, it, expect, beforeEach } from 'vitest';
import { detectField, parseAutocomplete } from '../src/lib/heuristics';

function mkInput(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('autocomplete grammar', () => {
  it.each([
    ['section-checkout shipping given-name', 'given-name'],
    ['section-checkout billing address-level2', 'city'],
    ['shipping home tel-national', 'tel'],
    ['work email', 'email'],
    ['username webauthn', 'username'],
    ['section-login current-password webauthn', 'current-password'],
    [' SECTION-A\tNEW-PASSWORD ', 'new-password'],
  ])('parses %s', (attribute, token) => {
    expect(parseAutocomplete(attribute)).toBe(token);
    expect(detectField(mkInput({ autocomplete: attribute }))).toBe(token);
  });

  it.each([
    'unknown', 'one-time-code', 'cc-number', 'current-password junk',
    'junk current-password', 'new-password current-password', 'section- email',
    'billing shipping email', 'home username', 'email work', 'webauthn username',
    'section-a section-b email', 'on email', 'email webauthn webauthn', '__proto__',
  ])('fails closed on unsupported or malformed autocomplete %s', (autocomplete) => {
    expect(parseAutocomplete(autocomplete)).toBeNull();
    expect(detectField(mkInput({ type: 'password', name: 'password', autocomplete }))).toBeNull();
    expect(detectField(mkInput({ type: 'email', name: 'email', autocomplete }))).toBeNull();
  });
});

describe('heuristics.detectField', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('maps W3C autocomplete tokens', () => {
    expect(detectField(mkInput({ autocomplete: 'email' }))).toBe('email');
    expect(detectField(mkInput({ autocomplete: 'username' }))).toBe('username');
    expect(detectField(mkInput({ autocomplete: 'current-password' }))).toBe('current-password');
    expect(detectField(mkInput({ autocomplete: 'given-name' }))).toBe('given-name');
    expect(detectField(mkInput({ autocomplete: 'address-level2' }))).toBe('city');
  });

  it('maps type attribute', () => {
    expect(detectField(mkInput({ type: 'email' }))).toBe('email');
    expect(detectField(mkInput({ type: 'tel' }))).toBe('tel');
    expect(detectField(mkInput({ type: 'password' }))).toBe('current-password');
  });

  it('matches heuristic on name/id', () => {
    expect(detectField(mkInput({ name: 'email' }))).toBe('email');
    expect(detectField(mkInput({ name: 'phone' }))).toBe('tel');
    expect(detectField(mkInput({ name: 'username' }))).toBe('username');
    expect(detectField(mkInput({ id: 'login_password' }))).toBe('current-password');
    expect(detectField(mkInput({ name: 'firstName' }))).toBe('given-name');
    expect(detectField(mkInput({ name: 'lastName' }))).toBe('family-name');
    expect(detectField(mkInput({ name: 'zip' }))).toBe('postal-code');
  });

  it('recognizes new-password over current-password', () => {
    expect(detectField(mkInput({ name: 'newPassword' }))).toBe('new-password');
    expect(detectField(mkInput({ name: 'confirmPassword' }))).toBe('new-password');
  });

  it('falls back through name → id → placeholder', () => {
    expect(detectField(mkInput({ placeholder: '邮箱' }))).toBe('email');
    expect(detectField(mkInput({ 'aria-label': 'phone number' }))).toBe('tel');
  });

  it('returns null for unrecognized input', () => {
    expect(detectField(mkInput({ type: 'text', name: 'q', id: 'q' }))).toBeNull();
  });

  it('autocomplete off does not match', () => {
    expect(detectField(mkInput({ autocomplete: 'off', name: 'email' }))).toBe('email');
  });

  it('matches Chinese漏网词 (收货人 / 联络方式 / 通讯地址 / 收货地址)', () => {
    expect(detectField(mkInput({ placeholder: '收货人' }))).toBe('name');
    expect(detectField(mkInput({ placeholder: '请填写收货人姓名' }))).toBe('name');
    expect(detectField(mkInput({ 'aria-label': '联络方式' }))).toBe('tel');
    expect(detectField(mkInput({ 'aria-label': '联系方式' }))).toBe('tel');
    expect(detectField(mkInput({ name: '通讯地址' }))).toBe('street-address');
    expect(detectField(mkInput({ placeholder: '收货地址' }))).toBe('street-address');
  });
});

describe('heuristics.detectField — label-based (React/shadcn style)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches via wrapping <label> text', () => {
    const label = document.createElement('label');
    label.textContent = '電話';
    const el = document.createElement('input');
    el.type = 'text';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('tel');
  });

  it('matches via wrapping <label> text "Phone"', () => {
    const label = document.createElement('label');
    label.textContent = 'Phone';
    const el = document.createElement('input');
    el.type = 'text';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('tel');
  });

  it('matches via <label for="id"> association', () => {
    const label = document.createElement('label');
    label.setAttribute('for', 'phone-field');
    label.textContent = 'Phone Number';
    document.body.appendChild(label);
    const el = document.createElement('input');
    el.id = 'phone-field';
    el.type = 'text';
    document.body.appendChild(el);
    expect(detectField(el)).toBe('tel');
  });

  it('label without matching word returns null', () => {
    const label = document.createElement('label');
    label.textContent = 'Random Text';
    const el = document.createElement('input');
    el.type = 'text';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBeNull();
  });
});

describe('heuristics.detectField — Traditional Chinese (香港 / 台灣)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches Traditional 電話 via label', () => {
    const label = document.createElement('label');
    label.textContent = '電話';
    const el = document.createElement('input');
    el.type = 'text';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('tel');
  });

  it('matches Traditional 電郵 via label', () => {
    const label = document.createElement('label');
    label.textContent = '電郵';
    const el = document.createElement('input');
    el.type = 'email';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('email');
  });
});

describe('heuristics.detectField — extended label sources', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches via previousElementSibling (shadcn div label)', () => {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Phone';
    const el = document.createElement('input');
    el.type = 'text';
    label.insertAdjacentElement('afterend', el);
    document.body.append(label, el);
    expect(detectField(el)).toBe('tel');
  });

  it('matches via aria-labelledby referencing a separate element', () => {
    const label = document.createElement('span');
    label.id = 'phone-label';
    label.textContent = 'Phone Number';
    document.body.appendChild(label);
    const el = document.createElement('input');
    el.type = 'text';
    el.setAttribute('aria-labelledby', 'phone-label');
    document.body.appendChild(el);
    expect(detectField(el)).toBe('tel');
  });

  it('matches Simplified 电邮 via placeholder', () => {
    expect(detectField(mkInput({ placeholder: '电邮' }))).toBe('email');
  });

  it('matches Simplified 电邮 via wrapping label', () => {
    const label = document.createElement('label');
    label.textContent = '电邮';
    const el = document.createElement('input');
    el.type = 'text';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('email');
  });
});

describe('heuristics.detectField — address lines', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('prefers address-line1/2 over the generic street-address', () => {
    expect(detectField(mkInput({ name: 'address_line1' }))).toBe('address-line1');
    expect(detectField(mkInput({ name: 'address_line2' }))).toBe('address-line2');
    expect(detectField(mkInput({ name: 'address1' }))).toBe('address-line1');
    expect(detectField(mkInput({ name: 'address2' }))).toBe('address-line2');
    expect(detectField(mkInput({ name: 'addr1' }))).toBe('address-line1');
    expect(detectField(mkInput({ id: 'shipping_address_2' }))).toBe('address-line2');
  });

  it('still maps a plain address field to street-address', () => {
    expect(detectField(mkInput({ name: 'address' }))).toBe('street-address');
    expect(detectField(mkInput({ name: 'street' }))).toBe('street-address');
    expect(detectField(mkInput({ placeholder: '通讯地址' }))).toBe('street-address');
  });
});

describe('heuristics.detectField — password intent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads new-password from the name, even though type is password', () => {
    expect(detectField(mkInput({ type: 'password', name: 'newPassword' }))).toBe('new-password');
    expect(detectField(mkInput({ type: 'password', name: 'confirmPassword' }))).toBe('new-password');
    expect(detectField(mkInput({ type: 'password', name: 'confirm_password' }))).toBe('new-password');
  });

  it('reads new-password from a visible label', () => {
    const label = document.createElement('label');
    label.textContent = '新密码';
    const el = document.createElement('input');
    el.type = 'password';
    label.appendChild(el);
    document.body.appendChild(label);
    expect(detectField(el)).toBe('new-password');
  });

  it('still falls back to current-password for a bare password input', () => {
    expect(detectField(mkInput({ type: 'password' }))).toBe('current-password');
    expect(detectField(mkInput({ type: 'password', name: 'password' }))).toBe('current-password');
    expect(detectField(mkInput({ type: 'password', name: 'pwd' }))).toBe('current-password');
  });

  it('keeps the explicit autocomplete token authoritative', () => {
    expect(detectField(mkInput({ type: 'password', autocomplete: 'new-password', name: 'password' })))
      .toBe('new-password');
    expect(detectField(mkInput({ type: 'password', autocomplete: 'current-password', name: 'newPassword' })))
      .toBe('current-password');
  });
});

describe('heuristics.detectField — bare CJK given/family name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('recognises single-character 姓 / 名 fields (word boundaries do not work on CJK)', () => {
    expect(detectField(mkInput({ name: '姓' }))).toBe('family-name');
    expect(detectField(mkInput({ name: '名' }))).toBe('given-name');
  });

  it('recognises 姓氏 as a family name', () => {
    expect(detectField(mkInput({ placeholder: '姓氏' }))).toBe('family-name');
  });

  it('leaves 姓名 to the full-name token', () => {
    expect(detectField(mkInput({ name: '姓名' }))).toBe('name');
    expect(detectField(mkInput({ placeholder: '收货人姓名' }))).toBe('name');
  });
});
