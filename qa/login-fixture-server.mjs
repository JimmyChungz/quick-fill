import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const user = '<label>Test account <input id="username" name="username" autocomplete="username" required></label>';
const password = '<label>Test password <input id="password" name="password" type="password" autocomplete="current-password" required></label>';
const status = '<p id="outcome" role="status">No fixture submission observed yet.</p>';
const style = 'body{font:16px/1.5 system-ui,sans-serif;max-width:54rem;margin:2rem auto;padding:0 1rem}section,form{border:1px solid #999;padding:1rem;margin:1rem 0}label{display:block;margin:.6rem 0}input,button{font:inherit;padding:.4rem}button,a{margin-right:.5rem}code{overflow-wrap:anywhere}';
function page(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quick Fill QA — ${title}</title><style>${style}</style></head><body><header><p><a href="/">Fixture index</a> · <a href="${({ 'Native POST': '/native', 'Native rejection': '/native-rejected' })[title] ?? ''}">Reload this fixture</a></p><h1>${title}</h1><p><strong>Synthetic credentials only.</strong> Type a made-up account and password. This fixture never authenticates anyone.</p></header><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
const done = `document.getElementById('outcome').textContent = 'Valid native submit event observed; this fixture prevented navigation. No authentication was attempted.';`;
const preventSubmit = `document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); ${done} });`;
const pages = new Map([
  ['/', page('Login acceptance fixtures', `<p>These pages exercise the actual installed MV3 extension. No Chrome API mock, storage shim, or browser automation is injected. Use the acceptance guide for expected extension results.</p><ul>
    <li><a href="/native">Native POST → same-origin landing</a></li>
    <li><a href="/native-rejected">Native POST → simulated rejection (HTTP 403)</a></li>
    <li><a href="/spa">Nested formless Continue + full DOM replacement</a></li>
    <li><a href="/spa-localized">Formless localized login actions</a></li>
    <li><a href="/spa-enter">Formless password Enter and negative controls</a></li>
    <li><a href="/constraints">Native constraints, Enter, and requestSubmit()</a></li>
    <li><a href="/signup">Negative: autocomplete=new-password</a></li>
    <li><a href="/two-password">Negative: two visible password fields</a></li>
    <li><a href="/change-password">Negative: password change</a></li>
    <li><a href="/unrelated">Negative: unrelated newsletter, control, navigation</a></li>
    <li><a href="/multi-step">Same-document username → password</a></li>
    </ul><p>Default origin: <code>http://127.0.0.1:4174</code>. Every path on the same host and port shares one extension origin; saved credentials and Never save affect all of these paths.</p>`) ],
  ['/native', page('Native POST', `<p>Fill both fields and click Log in. The server discards the POST body and redirects with HTTP 303 to a landing page on this origin. Quick Fill should offer Save there if this is a new, allowed credential.</p><form method="post" action="/native">${user}${password}<button type="submit">Log in</button></form>`) ],
  ['/native-rejected', page('Native rejection', `<p>The server discards the POST body and responds HTTP 403. Quick Fill should still ask to save: the product does not infer authentication success.</p><form method="post" action="/native-rejected">${user}${password}<button type="submit">Log in</button></form>`) ],
  ['/landing', page('Native landing', '<p id="outcome" role="status">Body discarded. Same-origin landing reached. No username or password was read, stored, logged, or echoed by the server.</p><p>Observe the extension prompt before returning to the fixture index.</p>') ],
  ['/spa', page('Formless SPA Continue', `<p>No form, fieldset, or role=form. Inputs and Continue are in separate nested wrappers within one authentication section. Continue replaces the app immediately, then the entire body and sibling hosts after 180 ms.</p><section id="auth-widget" aria-label="Synthetic account sign in"><div><div>${user}</div></div><div><div>${password}</div></div><div><button id="continue" type="button">Continue</button></div></section>${status}`, `
    document.getElementById('continue').addEventListener('click', () => {
      const fields = document.querySelectorAll('#auth-widget input');
      if ([...fields].some(field => !field.reportValidity())) return;
      document.getElementById('auth-widget').replaceChildren();
      document.getElementById('outcome').textContent = 'SPA submission observed; DOM replacement scheduled.';
      history.pushState({}, '', '#spa-complete');
      setTimeout(() => {
        const next = document.createElement('body');
        next.innerHTML = '<main><h1>SPA replacement complete</h1><p><strong>Synthetic credentials only.</strong></p><p id="outcome" role="status">Authentication inputs and the prior page body were removed. The extension prompt should remain available or recover once.</p><p><a href="/spa">Start a fresh SPA attempt</a> · <a href="/">Fixture index</a></p><button id="redraw" type="button">Unrelated DOM redraw</button><div id="updates"></div></main>';
        document.documentElement.replaceChildren(document.head, next);
        document.getElementById('redraw').addEventListener('click', () => {
          document.getElementById('updates').textContent = 'Unrelated UI updated. A dismissed operation must stay dismissed.';
        });
      }, 180);
    });`) ],
  ['/constraints', page('Native validation and submit methods', `<p>Account must be a synthetic email, such as qa-constraints@example.test. Password requires at least 8 characters. Empty/invalid fields must block native submission. Test the native button, Enter in the password field, and requestSubmit separately.</p><form id="auth">${user.replace('name="username"', 'name="username" type="email"')}${password.replace('required>', 'required minlength="8">')}<button id="native-submit" type="submit">Log in</button><button id="request-submit" type="button">Call requestSubmit()</button></form>${status}`, `${preventSubmit}
    document.getElementById('request-submit').addEventListener('click', () => document.getElementById('auth').requestSubmit(document.getElementById('native-submit')));
    document.getElementById('auth').addEventListener('invalid', () => { document.getElementById('outcome').textContent = 'Native constraint validation blocked submission; no submit event was dispatched.'; }, true);`) ],
  ['/spa-localized', page('Formless localized login actions', `<p>Select a localized login label, then enter synthetic credentials and click that action. Selecting a label alone must never capture. The other controls never submit a login.</p><label>Login label <select id="login-label"><option>Connexion</option><option>ログイン</option><option>Iniciar sesión</option></select></label><section id="auth-widget"><div>${user}</div><div>${password}</div><div><button id="localized-login" type="button">Connexion</button></div><div><button id="subscribe" type="button">Subscribe</button><button id="register" type="button">Register</button><button id="create-account" type="button">Create account</button><button id="show-password" type="button">Show password</button><button id="cancel" type="button">Cancel</button><button id="back" type="button">Back</button></div></section>${status}`, `
    document.getElementById('login-label').addEventListener('change', event => { document.getElementById('localized-login').textContent = event.target.value; });
    document.getElementById('localized-login').addEventListener('click', () => { document.getElementById('outcome').textContent = 'Localized synthetic login attempt observed.'; });
    for (const id of ['subscribe', 'register', 'create-account', 'show-password', 'cancel', 'back']) document.getElementById(id).addEventListener('click', () => { document.getElementById('outcome').textContent = 'Secondary control only; no login attempted.'; });`) ],
  ['/spa-enter', page('Formless password Enter', `<p>Enter in the current-password field is the synthetic login action. Enter in the account, notes, or unrelated field must never capture. Modified, repeated, and composing Enter must remain ignored.</p><section id="auth-widget"><div>${user}</div><div>${password}</div><div><button id="enter-login" type="button">Connexion</button></div></section><label>Notes <textarea id="notes"></textarea></label><label>Unrelated field <input id="unrelated-input"></label>${status}`, `
    const attempt = () => { document.getElementById('outcome').textContent = 'Formless synthetic login attempt observed.'; };
    document.getElementById('enter-login').addEventListener('click', attempt);
    document.getElementById('password').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); attempt(); }
    });`) ],
  ['/signup', page('Negative: new-password signup', `<p>Quick Fill should offer neither suggestions nor a save prompt, even after this valid native submit.</p><form>${user}<label>New password <input name="newPassword" type="password" autocomplete="new-password" required></label><button type="submit">Create account</button></form>${status}`, preventSubmit) ],
  ['/two-password', page('Negative: two visible passwords', `<p>Both password fields are visible and have current-password autocomplete. The two-password guard alone should suppress suggestions and capture.</p><form>${user}${password}<label>Second password <input name="second" type="password" autocomplete="current-password" required></label><button type="submit">Continue</button></form>${status}`, preventSubmit) ],
  ['/change-password', page('Negative: change password', `<p>Quick Fill should not suggest, capture, or update saved credentials here.</p><form>${password}<label>New password <input name="newPassword" type="password" autocomplete="new-password" required></label><button type="submit">Change password</button></form>${status}`, preventSubmit) ],
  ['/unrelated', page('Negative: unrelated activity', `<p>First type a synthetic account/password in the authentication form, but do not click its Log in button. Submit the separate newsletter form, click the external Continue control, or follow the navigation link. None is an authentication attempt.</p><form id="auth">${user}${password}<button type="submit">Log in (positive control)</button></form><form id="newsletter"><label>Newsletter email <input type="email" name="newsletter" autocomplete="email" required></label><button type="submit">Subscribe</button></form><section aria-label="Unrelated controls"><button id="unrelated" type="button">Continue</button><a href="/landing">Ordinary navigation / pagehide</a></section>${status}`, `
    document.getElementById('auth').addEventListener('submit', event => { event.preventDefault(); ${done} });
    document.getElementById('newsletter').addEventListener('submit', event => { event.preventDefault(); document.getElementById('outcome').textContent = 'Newsletter submitted only. No login was submitted and no values were sent.'; });
    document.getElementById('unrelated').addEventListener('click', () => { document.getElementById('outcome').textContent = 'Unrelated Continue clicked. No login was submitted.'; });`) ],
  ['/multi-step', page('Same-document username then password', `<p>Submit the explicit username step with Next. That form is removed, and the password step contains no username or hidden account field. Quick Fill must associate only the explicitly submitted account in this tab, or retain a safe blank username; it must never guess a stored account.</p><section id="steps"><form id="account-step">${user}<button type="submit">Next</button></form></section>${status}`, `
    document.getElementById('account-step').addEventListener('submit', event => {
      event.preventDefault();
      document.getElementById('steps').innerHTML = '<form id="password-step"><label>Test password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Continue</button></form>';
      history.pushState({}, '', '#password-step');
      document.getElementById('outcome').textContent = 'Explicit account step submitted; password step is now present.';
      document.getElementById('password-step').addEventListener('submit', next => { next.preventDefault(); ${done} });
    });`) ],
]);

/** Loopback-only caller should listen on 127.0.0.1; no request body is collected. */
export function createFixtureServer() {
  const server = createServer((request, response) => {
    request.on('error', () => response.destroy());
    let path;
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
      if (!['127.0.0.1', 'localhost'].includes(host)) throw Error('Unsupported host');
      path = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch { request.resume(); response.writeHead(400).end(); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method === 'POST' && ['/native', '/native-rejected'].includes(path)) {
      request.on('end', () => {
        if (path === '/native') response.writeHead(303, {Location: '/landing'}).end();
        else response.writeHead(403).end(page('Simulated server rejection', '<p id="outcome" role="status">Body discarded. Fixture intentionally rejected this login. Quick Fill should still offer to save a new credential.</p><a href="/native-rejected">Try a fresh rejected attempt</a>'));
      });
      request.resume();
      return;
    }
    request.resume();
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, {Allow: 'GET, HEAD'}).end(); return; }
    const body = pages.get(path);
    response.writeHead(body ? 200 : 404);
    response.end(request.method === 'HEAD' ? undefined : body ?? page('Not found', '<p>Unknown fixture path.</p>'));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function selfTest() {
  assert.equal(typeof createFixtureServer, 'function', 'fixture server factory must be available');
  const server = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/native', '/spa', '/spa-localized', '/spa-enter', '/constraints', '/signup', '/two-password', '/change-password', '/unrelated', '/multi-step']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /Synthetic credentials only/, path);
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
    }
    const response = await fetch(origin + '/native', {method: 'POST', body: 'username=synthetic-user&password=discard-only-marker', redirect: 'manual'});
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/landing');
    assert.doesNotMatch(await response.text(), /discard-only-marker/);
    const landing = await fetch(origin + '/landing');
    assert.match(await landing.text(), /Body discarded/);
    const rejected = await fetch(origin + '/native-rejected', {method: 'POST', body: 'password=discard-only-marker'});
    assert.equal(rejected.status, 403);
    assert.doesNotMatch(await rejected.text(), /discard-only-marker/);
    assert.equal((await fetch(origin + '/missing')).status, 404);
    console.log('PASS: fixture routes, native POST redirect/rejection, and no body reflection');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) await selfTest();
  else {
    const port = Number(process.env.PORT ?? 4174);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer from 0 to 65535');
    const server = createFixtureServer();
    server.on('error', () => { console.error('Fixture server could not listen; choose a free PORT.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({url: `http://127.0.0.1:${server.address().port}/`, pid: process.pid})));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  }
}
