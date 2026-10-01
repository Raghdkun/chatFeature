/**
 * The mock "customer website" the builder preview renders inside an `<iframe srcdoc>`.
 *
 * It loads the *real* loader (`/widget/v1/loader.js`) with a boot config built from the unsaved
 * draft (pre-registered in `window.__PNE_CHAT_BOOT__`, the convention of widget-config.md), so the
 * launcher, greeting flip and chat iframe are the production code running on draft data. A small
 * relay script forwards `draft` messages to the chat iframe (it only accepts messages whose
 * `event.source` is its direct parent, i.e. this document) and pushes the restyleable part to the
 * loader through `ChatFeature('update', ...)`.
 *
 * Being `srcdoc`, the document inherits the dashboard's origin: the relay therefore only trusts
 * messages from its parent with exactly that origin, and reports status the same way.
 */
import {
    PREVIEW_HOST_NS,
    type PreviewScheme,
} from '@/components/widgets/preview-protocol';
import type { ResolvedBootConfig } from '@/types/widgets';

export type PreviewHostOptions = {
    boot: ResolvedBootConfig;
    /** Absolute URL of the loader script. */
    loaderUrl: string;
    dir: 'ltr' | 'rtl';
    scheme: PreviewScheme;
    lang: string;
    /** Text shown as the fake site's name (already translated). */
    siteName: string;
};

/** JSON that is safe inside an inline `<script>` (no `</script>`, no line separators). */
export function safeJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Plain ES5 on purpose: it is injected as a string, so it must not depend on the bundler. It is
 * unit tested by running it against a fake `window` (`preview-host.test.ts`).
 */
export const RELAY_SOURCE = `(function () {
  var cfg = window.__PNE_PREVIEW__ || {};
  var ownOrigin = window.origin;
  var latest = null;

  function findChatFrame(root) {
    var frames = root.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      if ((frames[i].getAttribute('src') || '').indexOf('/embed/') !== -1) { return frames[i]; }
    }
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) {
        var found = findChatFrame(all[j].shadowRoot);
        if (found) { return found; }
      }
    }
    return null;
  }

  function hasLoader() { return typeof window.ChatFeature === 'function'; }

  function report(loader) {
    try {
      window.parent.postMessage({
        ns: '${PREVIEW_HOST_NS}', v: 1, type: 'status', loader: loader, frame: !!findChatFrame(document)
      }, ownOrigin);
    } catch (e) {}
  }

  function restyle(config) {
    return {
      defaultLocale: config.defaultLocale, theme: config.theme, launcher: config.launcher,
      texts: config.texts, greetings: config.greetings
    };
  }

  function deliver() {
    if (!latest) { return; }
    var frame = findChatFrame(document);
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(latest, cfg.embedOrigin);
    }
    try {
      if (hasLoader() && latest.payload && latest.payload.config) {
        window.ChatFeature('update', restyle(latest.payload.config));
      }
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== ownOrigin) { return; }
    var message = event.data;
    if (!message || typeof message !== 'object') { return; }
    if (message.ns === 'chatfeature' && message.v === 1 && message.type === 'draft') {
      latest = message;
      deliver();
    } else if (message.ns === '${PREVIEW_HOST_NS}' && message.v === 1 && message.type === 'command') {
      try {
        if (hasLoader() && (message.name === 'open' || message.name === 'close' || message.name === 'toggle')) {
          window.ChatFeature(message.name);
        }
      } catch (e) {}
    }
  });

  var script = document.querySelector('script[data-widget-key]');
  if (script) {
    script.addEventListener('load', function () { report(hasLoader() ? 'ready' : 'error'); deliver(); });
    script.addEventListener('error', function () { report('error'); });
  }
  report('loading');

  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    var frame = findChatFrame(document);
    if (frame && !frame.__pneWired) {
      frame.__pneWired = true;
      frame.addEventListener('load', deliver);
      deliver();
      report(hasLoader() ? 'ready' : 'loading');
    }
    if (tries > 80) { clearInterval(timer); }
  }, 250);
})();`;

const PAGE_CSS = (scheme: PreviewScheme) => {
    const dark = scheme === 'dark';

    return `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:${dark ? '#0b1220' : '#f6f8fa'};color:${dark ? '#e5e7eb' : '#1f2937'};-webkit-font-smoothing:antialiased}
.bar{display:block;border-radius:6px;background:${dark ? '#1f2937' : '#e2e8f0'}}
.site-header{display:flex;align-items:center;gap:20px;padding:16px 28px;background:${dark ? '#0f172a' : '#ffffff'};border-bottom:1px solid ${dark ? '#1f2937' : '#e5e7eb'}}
.logo{font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
.logo i{width:26px;height:26px;border-radius:8px;background:${dark ? '#334155' : '#cbd5e1'};display:block}
.nav{display:flex;gap:14px;margin-inline-start:auto}
.nav .bar{width:54px;height:10px}
.hero{padding:56px 28px 28px;max-width:760px}
.hero .bar.h1{height:26px;width:72%;margin-bottom:14px}
.hero .bar.h1.s{width:48%}
.hero .bar.p{height:11px;width:92%;margin-bottom:9px}
.hero .bar.p.s{width:64%}
.cta{display:inline-block;margin-top:14px;height:38px;width:132px;border-radius:9px;background:${dark ? '#334155' : '#cbd5e1'}}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:20px 28px 60px}
.card{border-radius:14px;background:${dark ? '#0f172a' : '#ffffff'};border:1px solid ${dark ? '#1f2937' : '#e5e7eb'};padding:18px}
.card .bar.t{height:12px;width:55%;margin-bottom:12px}
.card .bar.l{height:9px;width:100%;margin-bottom:8px}
.card .bar.l.s{width:70%}
@media (max-width:620px){.nav{display:none}.cards{grid-template-columns:1fr}.hero{padding-top:32px}.site-header{padding:14px 18px}.hero,.cards{padding-inline:18px}}
`;
};

/** The complete HTML document for the preview iframe (`srcdoc`). */
export function buildPreviewHostDocument(options: PreviewHostOptions): string {
    const { boot, loaderUrl, dir, scheme, lang, siteName } = options;
    let embedOrigin = boot.api.appOrigin;

    try {
        embedOrigin = new URL(boot.api.embed).origin;
    } catch {
        // keep the app origin
    }

    const preview = { key: boot.key, embedOrigin };

    return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}" style="color-scheme:${scheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<title>${escapeHtml(siteName)}</title>
<style>${PAGE_CSS(scheme)}</style>
</head>
<body data-scheme="${scheme}">
<header class="site-header">
  <span class="logo"><i></i>${escapeHtml(siteName)}</span>
  <nav class="nav" aria-hidden="true"><span class="bar"></span><span class="bar"></span><span class="bar"></span></nav>
</header>
<main>
  <section class="hero" aria-hidden="true">
    <span class="bar h1"></span><span class="bar h1 s"></span>
    <span class="bar p"></span><span class="bar p"></span><span class="bar p s"></span>
    <span class="cta"></span>
  </section>
  <section class="cards" aria-hidden="true">
    <div class="card"><span class="bar t"></span><span class="bar l"></span><span class="bar l s"></span></div>
    <div class="card"><span class="bar t"></span><span class="bar l"></span><span class="bar l s"></span></div>
    <div class="card"><span class="bar t"></span><span class="bar l"></span><span class="bar l s"></span></div>
  </section>
</main>
<script>window.__PNE_CHAT_BOOT__=window.__PNE_CHAT_BOOT__||{};window.__PNE_CHAT_BOOT__[${safeJson(boot.key)}]=${safeJson(boot)};window.__PNE_PREVIEW__=${safeJson(preview)};</script>
<script src="${escapeHtml(loaderUrl)}" data-widget-key="${escapeHtml(boot.key)}" data-open-on-load="false" async></script>
<script>${RELAY_SOURCE}</script>
</body>
</html>`;
}
