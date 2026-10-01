#!/usr/bin/env node
/**
 * Static dev server for manual testing of the widget loader without the Laravel backend.
 *
 *   npm run build:widget && node resources/widget/dev/serve.mjs
 *
 * It starts TWO origins so the test is genuinely cross-origin (like a customer site embedding the chat):
 *
 *   app  http://localhost:8211   fake chat app: /w/<key>.js, /widget/v1/loader.js, /embed/<key> (panel-mock.html),
 *                                /api/v1/public/widgets/<key>/config (CORS), /avatars/*.svg
 *   host http://localhost:8212   the "customer site": host.html + panel-mock/asset files from this folder
 *
 * Open http://localhost:8212/ . Both servers stop with Ctrl+C. Nothing is written to disk, nothing is installed.
 *
 * Demo knobs for /w/<key>.js and the config endpoint (query string on the *script URL*):
 *   delay=1 interval=1 autohide=10 dismiss=session|interval|never style=pill position=left mode=dark|light|auto
 *   rtl=1 theme=%23c026d3 sound=0 titleBadge=1 greetings=0
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const LOADER = join(root, 'public', 'widget', 'v1', 'loader.js');
const APP_PORT = Number(process.env.APP_PORT ?? 8211);
const HOST_PORT = Number(process.env.HOST_PORT ?? 8212);
const APP = `http://localhost:${APP_PORT}`;
const HOST = `http://localhost:${HOST_PORT}`;

const avatar = (initials, bg) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="41" font-family="system-ui,sans-serif" font-size="26" font-weight="700" text-anchor="middle" fill="#fff">${initials}</text></svg>`;
const AVATARS = {
    '/avatars/sara.svg': avatar('SA', '#7c3aed'),
    '/avatars/omar.svg': avatar('OM', '#0369a1'),
    '/avatars/lena.svg': avatar('LE', '#be123c'),
};

function bootFor(key, q) {
    const num = (k, d) =>
        q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d;

    return {
        v: 1,
        key,
        configVersion: 12,
        generatedAt: new Date().toISOString(),
        api: {
            base: `${APP}/api/v1/public`,
            embed: `${APP}/embed/${key}`,
            appOrigin: APP,
        },
        config: {
            v: 1,
            defaultLocale: 'en',
            localeDetect: true,
            theme: {
                mode: q.get('mode') ?? 'auto',
                primary: q.get('theme') ?? '#0f766e',
                position:
                    q.get('position') === 'left'
                        ? 'bottom-left'
                        : 'bottom-right',
                shadow: 'soft',
            },
            launcher: {
                style: q.get('style') ?? 'bubble',
                icon: 'chat',
                label: 'Chat with us',
            },
            texts: {
                en: {
                    title: 'Support',
                    closeChat: 'Close chat',
                    dismiss: 'Dismiss',
                    unread: 'unread messages',
                },
                ar: {
                    title: 'الدعم',
                    closeChat: 'إغلاق الدردشة',
                    dismiss: 'إخفاء',
                    unread: 'رسائل غير مقروءة',
                },
            },
            features: {
                sounds: q.get('sound') !== '0',
                titleBadge: q.get('titleBadge') === '1',
            },
            greetings: {
                enabled: q.get('greetings') !== '0',
                onPageLoad: true,
                delaySeconds: num('delay', 3),
                intervalMinutes: num('interval', 30),
                autoHideSeconds: num('autohide', 20),
                dismissPolicy: q.get('dismiss') ?? 'session',
                showAgent: true,
            },
        },
        greetings: [
            {
                id: 'g1',
                body: 'Hi! Need a hand choosing a plan?',
                agentName: 'Sara',
                agentAvatarUrl: `${APP}/avatars/sara.svg`,
                locale: null,
                weight: 3,
            },
            {
                id: 'g2',
                body: 'Questions about billing? Ask me anything.',
                agentName: 'Omar',
                agentAvatarUrl: `${APP}/avatars/omar.svg`,
                locale: null,
                weight: 2,
            },
            {
                id: 'g3',
                body: 'Welcome back! Anything I can help with today?',
                agentName: 'Lena',
                agentAvatarUrl: `${APP}/avatars/lena.svg`,
                locale: null,
                weight: 1,
            },
            {
                id: 'g4',
                body: 'مرحباً! كيف يمكنني مساعدتك اليوم؟',
                agentName: 'سارة',
                agentAvatarUrl: null,
                locale: 'ar',
                weight: 1,
            },
        ],
        categories: [
            { slug: 'billing', label: 'Billing' },
            { slug: 'sales', label: 'Sales' },
            { slug: 'tech', label: 'Technical' },
        ],
        availability: {
            online: true,
            openNow: true,
            nextOpenAt: null,
            whatsapp: { enabled: false },
        },
    };
}

const cors = (req, res) => {
    // The real endpoint echoes ACAO only for whitelisted widget domains; the fake allows the demo host.
    if (req.headers.origin === HOST) {
        res.setHeader('Access-Control-Allow-Origin', HOST);
        res.setHeader('Vary', 'Origin');
    }
};
const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...extra,
    });
    res.end(body);
};

const app = createServer((req, res) => {
    const url = new URL(req.url ?? '/', APP);
    const p = url.pathname;
    cors(req, res);

    if (req.method === 'OPTIONS') {
        return send(res, 204, 'text/plain', '', {
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'Accept',
        });
    }

    let m;

    if ((m = /^\/w\/([A-Za-z0-9_-]+)\.js$/.exec(p))) {
        if (!existsSync(LOADER)) {
            return send(
                res,
                200,
                'text/javascript',
                'console.warn("[chatfeature] public/widget/v1/loader.js is missing: run npm run build:widget");',
            );
        }

        const prelude = `(function(){var b=(window.__PNE_CHAT_BOOT__=window.__PNE_CHAT_BOOT__||{});b[${JSON.stringify(m[1])}]=${JSON.stringify(bootFor(m[1], url.searchParams))};})();\n`;

        return send(
            res,
            200,
            'text/javascript',
            prelude + readFileSync(LOADER, 'utf8'),
        );
    }

    if (p === '/widget/v1/loader.js') {
        return send(
            res,
            200,
            'text/javascript',
            existsSync(LOADER) ? readFileSync(LOADER, 'utf8') : '',
        );
    }

    if (
        (m = /^\/api\/v1\/public\/widgets\/([A-Za-z0-9_-]+)\/config$/.exec(p))
    ) {
        if (req.headers.origin !== HOST) {
            return send(
                res,
                403,
                'application/json',
                JSON.stringify({
                    error: {
                        code: 'origin_not_allowed',
                        message: 'Origin not allowed',
                    },
                }),
            );
        }

        return send(
            res,
            200,
            'application/json',
            JSON.stringify({ data: bootFor(m[1], url.searchParams) }),
        );
    }

    if (/^\/embed\/[A-Za-z0-9_-]+$/.test(p)) {
        return send(
            res,
            200,
            'text/html; charset=utf-8',
            readFileSync(join(here, 'panel-mock.html')),
            { 'Content-Security-Policy': `frame-ancestors ${HOST}` },
        );
    }

    if (p in AVATARS) {
        return send(res, 200, 'image/svg+xml', AVATARS[p]);
    }

    return send(res, 404, 'text/plain', 'not found');
});

const host = createServer((req, res) => {
    const p = new URL(req.url ?? '/', HOST).pathname;
    const file = p === '/' ? 'host.html' : p.replace(/^\//, '');

    if (!/^[A-Za-z0-9._-]+$/.test(file) || !existsSync(join(here, file))) {
        return send(res, 404, 'text/plain', 'not found');
    }

    const type = file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.js') || file.endsWith('.mjs')
          ? 'text/javascript'
          : 'text/plain';

    return send(
        res,
        200,
        type,
        readFileSync(join(here, file)).toString().replaceAll('__APP__', APP),
    );
});

app.listen(APP_PORT, () => console.log(`app  ${APP}`));
host.listen(HOST_PORT, () => console.log(`host ${HOST}   <- open this`));
