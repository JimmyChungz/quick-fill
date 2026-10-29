// ID generation that also works on plain http:// pages.
//
// crypto.randomUUID() is gated on a secure context (HTTPS, localhost, file://).
// Content scripts inherit the page's context, so on an http:// site
// `crypto.randomUUID` is undefined and calling it throws — which used to make
// the "save" button silently do nothing. getRandomValues() is the only Crypto
// member the spec allows in an insecure context, so it is the fallback.
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* fall through to the manual path */
    }
  }

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4 shape, so ids stay recognisable as UUIDs.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
