#!/usr/bin/env node
/**
 * The "customer site" of the cross-origin embed tests: a tiny static server on ANOTHER origin than the chat app
 * (`http://localhost:<port>` while the app lives on `http://127.0.0.1:<app port>`), started by Playwright's
 * `webServer` (one per scenario instance with a `hostPort`, see e2e/support/scenarios.ts).
 *
 *   node e2e/support/host-server.mjs --port=8242 --app=http://127.0.0.1:8236
 *
 * `GET /page.html` renders a small shop page that includes the widget. Everything is controlled by the query string,
 * so one server serves every test (`hostPage()` in e2e/support/host.ts builds these URLs):
 *
 *   key=wk_...       widget public key                      src=w | generic | none   how to include it
 *   attrs={"position":"left"}   data-* attributes of the <script> (JSON, names without the `data-` prefix)
 *   settings={...}   window.ChatFeatureSettings (JSON)      twice=1                  include the script twice
 *   hostile=1        hostile global CSS (`* { all: unset }`, `div, button { display: none !important }`, ...)
 *   rtl=1            <html dir="rtl" lang="ar">             csp=1                    strict page CSP (script/frame/connect only)
 *   height=2400      page height in px (scroll tests)       late=500                 add the script N ms after load
 *
 * Every widget event is recorded in `window.__events` ({ name, data, at }), the page has a few clickable elements
 * the widget must not cover or break, and nothing here sets a cookie. Not part of the app: test support only.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(
    process.argv
        .slice(2)
        .map((arg) => arg.replace(/^--/, '').split('='))
        .map(([key, ...rest]) => [key, rest.join('=')]),
);
const PORT = Number(args.port);
const APP = String(args.app ?? '').replace(/\/$/, '');

if (!Number.isInteger(PORT) || PORT < 1 || !/^https?:\/\/[^/]+$/.test(APP)) {
    console.error('usage: host-server.mjs --port=<port> --app=<app origin>');
    process.exit(2);
}

const EVENTS = [
    'ready',
    'open',
    'close',
    'chat-started',
    'chat-ended',
    'agent-joined',
    'message-sent',
    'message-received',
    'unread-changed',
    'greeting-shown',
    'greeting-dismissed',
    'rating-submitted',
    'error',
];

const HOSTILE_CSS = `
* { all: unset !important; }
* { font-family: 'Comic Sans MS', cursive !important; letter-spacing: 3px !important; }
div, button, span, img, iframe, a { display: none !important; }
pne-chat-widget { display: none !important; position: static !important; width: 400px !important; height: 400px !important; visibility: hidden !important; opacity: 0 !important; }
body > * { position: static !important; }
iframe { border: 6px solid red !important; width: 10px !important; }
`;

const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1e293b; background: #f8fafc; }
header, section, footer { max-width: 920px; margin: 0 auto; padding: 24px 20px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
header strong { font-size: 20px; }
nav a { margin-inline-start: 16px; color: #475569; text-decoration: none; }
h1 { font-size: 34px; line-height: 1.15; margin: 0 0 8px; }
.lead { color: #475569; max-width: 52ch; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-top: 24px; }
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
.card b { display: block; margin-bottom: 4px; }
.cta { display: inline-block; margin-top: 12px; padding: 8px 14px; border-radius: 8px; background: #1e293b; color: #fff; border: 0; font: inherit; cursor: pointer; }
.filler { height: var(--filler, 2000px); background: repeating-linear-gradient(#f1f5f9, #f1f5f9 40px, #e2e8f0 40px, #e2e8f0 80px); border-radius: 12px; margin-top: 24px; }
footer { color: #64748b; font-size: 14px; }
@media (prefers-color-scheme: dark) {
  body { color: #e2e8f0; background: #0f172a; }
  .card { background: #1e293b; border-color: #334155; }
  nav a, .lead { color: #94a3b8; }
  .filler { background: repeating-linear-gradient(#111827, #111827, #1f2937 40px, #1f2937 80px); }
}
`;

const html = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const json = (value, fallback) => {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
};

function page(query) {
    const key = query.get('key') ?? '';
    const src = query.get('src') ?? 'w';
    const attrs = json(query.get('attrs'), {});
    const settings = json(query.get('settings'), null);
    const rtl = query.get('rtl') === '1';
    const hostile = query.get('hostile') === '1';
    const csp = query.get('csp') === '1';
    const twice = query.get('twice') === '1';
    const late = Number(query.get('late') ?? 0);
    const height = Math.min(
        Math.max(Number(query.get('height') ?? 2000), 0),
        20000,
    );
    const nonce = csp ? randomBytes(12).toString('base64') : null;
    const n = nonce ? ` nonce="${nonce}"` : '';

    const url =
        src === 'generic'
            ? `${APP}/widget/v1/loader.js`
            : `${APP}/w/${encodeURIComponent(key)}.js`;
    const attributes = Object.entries(attrs)
        .filter(([name]) => /^[a-z][a-z0-9-]*$/.test(name))
        .map(([name, value]) => ` data-${name}="${html(value)}"`)
        .join('');
    const keyAttribute =
        src === 'generic' ? ` data-widget-key="${html(key)}"` : '';
    const tag = `<script async${n} src="${url}"${keyAttribute}${attributes}></script>`;

    // The stub queue of the documented snippet, plus a recorder for every event (subscribed before the loader runs).
    const bootstrap = `
window.__events = [];
window.ChatFeature = window.ChatFeature || function () { (window.ChatFeature.q = window.ChatFeature.q || []).push(arguments); };
${settings === null ? '' : `window.ChatFeatureSettings = ${JSON.stringify(settings).replaceAll('<', '\\u003c')};`}
${JSON.stringify(EVENTS)}.forEach(function (name) {
  ChatFeature('on', name, function (data) { window.__events.push({ name: name, data: data, at: Date.now() }); });
});
window.__hostClicks = 0;`;

    const include =
        src === 'none'
            ? ''
            : late > 0
              ? `<script${n}>setTimeout(function(){var s=document.createElement('script');s.async=true;s.src=${JSON.stringify(url)};${
                    src === 'generic'
                        ? `s.dataset.widgetKey=${JSON.stringify(key)};`
                        : ''
                }document.body.appendChild(s);}, ${late});</script>`
              : twice
                ? `${tag}\n${tag}`
                : tag;

    const stylesheet = hostile ? `<style>${HOSTILE_CSS}</style>` : '';

    return {
        csp: csp
            ? `default-src 'none'; script-src 'nonce-${nonce}' ${APP}; style-src 'self'; frame-src ${APP}; connect-src ${APP}; img-src 'self' ${APP} data:; font-src ${APP}`
            : null,
        body: `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(query.get('title') ?? 'Acme Store')}</title>
<link rel="stylesheet" href="/host.css?height=${height}">
${stylesheet}
<script${n}>${bootstrap}</script>
</head>
<body>
<header><strong>Acme Store</strong><nav><a href="#shoes">Shoes</a><a href="#bags">Bags</a><a href="#help">Help</a></nav></header>
<section>
  <h1 data-testid="host-heading">Everything for the trail</h1>
  <p class="lead">A customer site on its own origin. The chat widget is included with one script tag; this page only provides the surroundings.</p>
  <button class="cta" id="host-button" type="button" onclick="window.__hostClicks++">Add to cart</button>
  <div class="grid">
    <div class="card"><b>Trail runner</b>Light, grippy, ready.</div>
    <div class="card"><b>Day pack 20L</b>Fits a laptop.</div>
    <div class="card"><b>Rain shell</b>Packs into its pocket.</div>
  </div>
  <div class="filler"></div>
</section>
<footer id="host-footer">Acme Store, 12 Example Street. Support hours are on the help page.</footer>
${include}
</body>
</html>`,
    };
}

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const send = (status, type, body, extra = {}) => {
        res.writeHead(status, {
            'Content-Type': type,
            'Cache-Control': 'no-store',
            ...extra,
        });
        res.end(body);
    };

    if (url.pathname === '/__health') {
        return send(200, 'text/plain', 'ok');
    }

    if (url.pathname === '/host.css') {
        const height = Math.min(
            Math.max(Number(url.searchParams.get('height') ?? 2000), 0),
            20000,
        );

        return send(
            200,
            'text/css; charset=utf-8',
            `:root { --filler: ${height}px; }\n${CSS}`,
        );
    }

    if (url.pathname === '/page.html') {
        const { body, csp } = page(url.searchParams);

        return send(
            200,
            'text/html; charset=utf-8',
            body,
            csp === null ? {} : { 'Content-Security-Policy': csp },
        );
    }

    if (url.pathname === '/favicon.ico') {
        return send(204, 'text/plain', '');
    }

    return send(404, 'text/plain', 'not found');
});

server.listen(PORT, () =>
    console.log(`host page server on :${PORT} (app ${APP})`),
);

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
