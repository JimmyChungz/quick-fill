import type { FieldToken } from './types';
import { AUTOCOMPLETE_MAP, TYPE_MAP } from './tokens';

type AttrSource = 'name' | 'id' | 'placeholder' | 'aria-label';
const HEURISTIC_ATTRS: AttrSource[] = ['name', 'id', 'placeholder', 'aria-label'];

// Ordered roughly by specificity: more specific patterns first so e.g. 'new-password' wins over
// 'current-password', and 'address-line1' wins over the generic 'street-address'.
const HEURISTIC: Array<{ token: FieldToken; pattern: RegExp }> = [
  { token: 'new-password',        pattern: /(new.?pass|confirm.?pass|repeat.?pass|新密码|确认密码)/i },
  { token: 'current-password',    pattern: /(pass.?word|^pwd$|^passwd$|^pass$|密码)/i },
  { token: 'username',            pattern: /(user.?name|^login$|login.?id|account|nickname|昵称|用户名|账号)/i },
  { token: 'email',               pattern: /(e[\-_]?mail|邮箱|電郵|电邮|邮件)/i },
  { token: 'tel',                 pattern: /(phone|mobile|^tel$|手机|电话|電話|聯絡方式|聯繫方式|联络方式|联系方式|联系)/i },
  // name BEFORE given/family so 姓名 / full-name matches name first
  { token: 'name',                pattern: /(full.?name|^name$|^name\b|姓名|收货人|名字)/i },
  // given-name / family-name: English 'first'/'last', or the bare CJK 名 / 姓.
  // Do NOT use \b here: JS word boundaries are ASCII-only, so `\b名\b` never
  // matches inside CJK text — it silently disabled both rules.
  { token: 'given-name',          pattern: /(first.?name|given.?name|^名$|^名字$)/i },
  { token: 'family-name',         pattern: /(last.?name|family.?name|surname|^姓$|^姓氏$)/i },
  { token: 'organization',        pattern: /(company|organization|^org$|公司|组织)/i },
  // address-line1/2 sit ABOVE street-address: that generic pattern contains a
  // bare `address`, so `address1` / `address_line2` were swallowed by it and
  // both lines of an address got filled with the same value.
  { token: 'address-line1',       pattern: /(address.?line.?1|address.?1(?!\d)|addr.?1(?!\d)|地址1)/i },
  { token: 'address-line2',       pattern: /(address.?line.?2|address.?2(?!\d)|addr.?2(?!\d)|地址2)/i },
  { token: 'street-address',      pattern: /(street|address|地址|通讯地址|收货地址)/i },
  { token: 'city',                pattern: /(city|^town$|城市)/i },
  { token: 'region',              pattern: /(state|province|region|省|州)/i },
  // postal-code: include 邮政编码 (full term) in addition to 邮编 (abbreviation)
  { token: 'postal-code',         pattern: /(zip|postal|post.?code|邮编|邮政编码)/i },
  { token: 'country',             pattern: /(country|国家)/i },
];

function matchHeuristic(text: string): FieldToken | null {
  for (const { token, pattern } of HEURISTIC) {
    if (pattern.test(text)) return token;
  }
  return null;
}

/** Parse the supported subset of the ordered HTML autocomplete token grammar.
 * Unsupported fields (OTP, payment cards, etc.) and malformed combinations
 * deliberately return null rather than falling back to a credential guess. */
export function parseAutocomplete(value: string): FieldToken | null {
  const parts = value.trim().toLowerCase().split(/\s+/);
  if (parts[0]?.startsWith('section-')) {
    if (parts[0].length === 'section-'.length) return null;
    parts.shift();
  }
  if (parts[0] === 'shipping' || parts[0] === 'billing') parts.shift();
  const contact = /^(home|work|mobile|fax|pager)$/.test(parts[0] ?? '');
  if (contact) parts.shift();
  const detail = parts.shift() ?? '';
  if (contact && detail !== 'email' && detail !== 'tel' && detail !== 'tel-national') return null;
  if (parts[0] === 'webauthn') parts.shift();
  if (parts.length || !Object.hasOwn(AUTOCOMPLETE_MAP, detail)) return null;
  return AUTOCOMPLETE_MAP[detail]!;
}

export function detectField(el: Element): FieldToken | null {
  // 1. autocomplete attribute (W3C standard, highest priority)
  const ac = (el.getAttribute('autocomplete') ?? '').trim().toLowerCase();
  if (ac && ac !== 'off' && ac !== 'on') {
    return parseAutocomplete(ac);
  }

  // 2. unambiguous input types (email / tel). `password` is resolved in step 5.
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    if (t in TYPE_MAP) return TYPE_MAP[t]!;
  }

  // 3. heuristic over name/id/placeholder/aria-label, per-attribute, priority order
  for (const attr of HEURISTIC_ATTRS) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const hit = matchHeuristic(v);
    if (hit) return hit;
  }

  // 4. heuristic over associated <label> text content (React/shadcn-style sites
  //    put the visible label in a sibling <label>, not in any input attribute).
  //    Also covers aria-labelledby references and previousElementSibling text
  //    (shadcn <div class="label">Phone</div> right before the input).
  const labelTexts: string[] = [];
  if (el instanceof HTMLElement) {
    // 4a. <label for="..."> and <label> wrapping the input.
    const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
    if (labels) {
      for (const label of Array.from(labels)) {
        if (label.textContent) labelTexts.push(label.textContent);
      }
    }
    // 4b. aria-labelledby references (by id) — collect referenced elements' text.
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        if (!id) continue;
        const ref = document.getElementById(id);
        if (ref && ref.textContent) labelTexts.push(ref.textContent);
      }
    }
    // 4c. Previous element sibling (e.g. shadcn <div class="label">Phone</div>
    //     right before the <input>). Skip a container that holds other form
    //     controls — its text is the whole form, not this field's label — and
    //     cap the length so a giant wrapper cannot produce a random match.
    const prev = el.previousElementSibling;
    if (prev && !(prev instanceof HTMLInputElement)
        && !prev.querySelector('input, select, textarea')
        && prev.textContent && prev.textContent.length <= 64) {
      labelTexts.push(prev.textContent);
    }
  }
  for (const text of labelTexts) {
    const hit = matchHeuristic(text);
    if (hit) return hit;
  }

  // 5. password fallback: a password input with no other signal is the field you
  //    type your existing password into. This MUST stay after steps 3-4 so that
  //    `name=newPassword` or a 新密码 label still wins.
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') {
    return 'current-password';
  }
  return null;
}
