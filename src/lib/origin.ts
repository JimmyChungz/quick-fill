// Origin normalisation, shared by every surface that writes a login URL.
//
// The content script matches saved logins with a strict `p.url === origin`
// comparison, so anything that is not a bare origin silently stops matching.
// Two traps this closes:
//   * `new URL('github.com').origin` is the string "null" — a scheme-less input
//     parses as a scheme, not a host — so the old popup code stored "null";
//   * the options page stored whatever the user typed, path and query included.
//
// v2 audit fix: loopback / mDNS / raw host:port inputs used to be guessed as
// https://, which silently broke every localhost / 127.x / .local dev server
// login. They now try http:// first, then fall back to https://.
function isAmbiguousLocal(input: string): boolean {
  // We only need to recognise the *prefix* — the URL parser handles port, path,
  // and the rest of an IPv4 address. A boundary is required after the prefix
  // so that `127abc` is not treated as local.
  return /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.local)(\b|$|:|\/)/i.test(input);
}

export function normalizeOrigin(input: string): string {
  const raw = input.trim();
  if (!raw) return '';

  const candidates = isAmbiguousLocal(raw)
    ? [raw, `http://${raw}`, `https://${raw}`]
    : [raw, `https://${raw}`];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      /* try the next candidate */
    }
  }
  return raw;
}
