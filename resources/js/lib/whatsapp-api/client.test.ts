import { describe, expect, it } from 'vite-plus/test';
import { ApiError, createApiClient } from '@/lib/api-client';
import {
    classifyWaError,
    connectionResultFromWire,
    createWaApi,
    describeWaError,
    qrFromWire,
    settingsBody,
    settingsFromWire,
    waitLabel,
    WA_SETTINGS_DEFAULTS,
} from '@/lib/whatsapp-api/client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import { interpolate } from '@/lib/i18n';
import { en } from '@/tests/lang';

const t = (key: string, replacements?: Record<string, string | number>) =>
    interpolate(en[key] ?? key, replacements);

type Call = { url: string; init: RequestInit };

function clientWith(reply: (call: Call) => Response) {
    const calls: Call[] = [];
    const client = createApiClient({
        fetchImpl: async (input, init) => {
            const url =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            const call = { url, init: init ?? {} };

            calls.push(call);

            return reply(call);
        },
        xsrfToken: () => 'xsrf-1',
        csrfCookieUrl: null,
        onUnauthenticated: () => undefined,
    });

    return { api: createWaApi(client), calls };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

const bodyOf = (call: Call): unknown => JSON.parse(call.init.body as string);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('routes', () => {
    it('spells every path in one place and encodes the ids', () => {
        expect(waRoutes.api.sessionStart('01A/B')).toBe(
            '/api/v1/whatsapp/sessions/01A%2FB/start',
        );
        expect(waRoutes.api.chatMessages('01ABC')).toBe(
            '/api/v1/whatsapp/chats/01ABC/messages',
        );
        expect(waRoutes.api.widgetWhatsApp('w1')).toBe(
            '/api/v1/widgets/w1/whatsapp',
        );
        expect(waRoutes.pages.chat('01ABC')).toBe('/whatsapp/01ABC');
        expect(waRoutes.pages.settings()).toBe('/settings/whatsapp');
        // The public hand-off is relative to the boot config's `api.base` (`/api/v1/public`).
        expect(waRoutes.handoff('wk_abc')).toBe(
            '/widgets/wk_abc/whatsapp-handoff',
        );
    });
});

describe('settings', () => {
    it('reads both spellings and fills what the server leaves out with the defaults', () => {
        expect(
            settingsFromWire({
                base_url: 'https://openwa.example.com',
                has_api_key: true,
                daily_send_cap: 50,
                replyOnlyToInbound: false,
            }),
        ).toEqual({
            ...WA_SETTINGS_DEFAULTS,
            baseUrl: 'https://openwa.example.com',
            hasApiKey: true,
            dailySendCap: 50,
            replyOnlyToInbound: false,
        });
        expect(settingsFromWire(null)).toEqual(WA_SETTINGS_DEFAULTS);
    });

    it('sends only what changed, in snake_case, and never a blank API key', () => {
        expect(
            settingsBody({
                baseUrl: 'https://x.test',
                dailySendCap: 10,
                apiKey: '   ',
            }),
        ).toEqual({ base_url: 'https://x.test', daily_send_cap: 10 });
        expect(settingsBody({ apiKey: ' secret-key ' })).toEqual({
            api_key: 'secret-key',
        });
        expect(settingsBody({ clearApiKey: true })).toEqual({ api_key: null });
        expect(settingsBody({ ignoreGroups: false })).toEqual({
            ignore_groups: false,
        });
    });

    it('PATCHes the body with the cookie headers and returns the parsed settings', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: { base_url: 'https://x.test', has_api_key: true } }),
        );
        const saved = await api.saveSettings({
            baseUrl: 'https://x.test',
            apiKey: 'k',
        });

        expect(calls[0].url).toBe('/api/v1/whatsapp/settings');
        expect(calls[0].init.method).toBe('PATCH');
        expect(
            (calls[0].init.headers as Record<string, string>)['X-XSRF-TOKEN'],
        ).toBe('xsrf-1');
        expect(bodyOf(calls[0])).toEqual({
            base_url: 'https://x.test',
            api_key: 'k',
        });
        expect(saved.hasApiKey).toBe(true);
    });
});

describe('connection test', () => {
    it('reads the role and the engine of a good key', () => {
        expect(
            connectionResultFromWire({
                ok: true,
                role: 'admin',
                engine: 'baileys',
            }),
        ).toEqual({ ok: true, role: 'admin', engine: 'baileys' });
    });

    it('turns a failed check into a result, not an exception', async () => {
        const { api } = clientWith(() =>
            json(
                { error: { code: 'openwa_unavailable', message: 'No route.' } },
                502,
            ),
        );

        await expect(api.testConnection()).resolves.toEqual({
            ok: false,
            code: 'openwa_unavailable',
            message: 'No route.',
        });
    });

    it('reads { ok: false } answers too, and still throws what is not about OpenWA (403, a dropped connection)', async () => {
        const failed = clientWith(() =>
            json({
                data: { ok: false, code: 'invalid_api_key', message: 'Bad' },
            }),
        );

        await expect(failed.api.testConnection()).resolves.toEqual({
            ok: false,
            code: 'invalid_api_key',
            message: 'Bad',
        });

        const forbidden = clientWith(() =>
            json({ error: { code: 'forbidden', message: 'No.' } }, 403),
        );

        await expect(forbidden.api.testConnection()).rejects.toBeInstanceOf(
            ApiError,
        );
    });
});

describe('QR', () => {
    it('keeps only a base64 PNG / JPEG data URL as the picture', () => {
        expect(qrFromWire({ status: 'qr', qr: PNG })).toEqual({
            status: 'qr',
            image: PNG,
            expiresAt: null,
        });
        expect(
            qrFromWire({ status: 'qr', qr: 'https://evil.test/x.png' }).image,
        ).toBeNull();
        expect(
            qrFromWire({
                status: 'qr',
                qr: 'data:text/html;base64,PHNjcmlwdD4=',
            }).image,
        ).toBeNull();
        expect(
            qrFromWire({
                status: 'qr',
                qr: 'data:image/svg+xml;base64,PHN2Zz4=',
            }).image,
        ).toBeNull();
        expect(qrFromWire({ status: 'ready' })).toEqual({
            status: 'ready',
            image: null,
            expiresAt: null,
        });
    });

    it('asks for the picture without any caching', async () => {
        const { api, calls } = clientWith(() =>
            json({
                data: {
                    status: 'qr',
                    qr: PNG,
                    expires_at: '2026-11-20T10:01:00Z',
                },
            }),
        );
        const qr = await api.qr('01SESSION');

        expect(calls[0].url).toBe('/api/v1/whatsapp/sessions/01SESSION/qr');
        expect(calls[0].init.cache).toBe('no-store');
        expect(qr.expiresAt).toBe('2026-11-20T10:01:00Z');
    });
});

describe('chats and messages', () => {
    it('lists chats with the filters as query parameters and reads the cursor from the meta', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: [{ ulid: 'c1' }], meta: { next_cursor: 'page-2' } }),
        );
        const page = await api.chats({
            status: 'open',
            session: 's1',
            linked: false,
            unread: true,
            q: 'invoice',
            sort: 'unread',
            cursor: 'page-1',
            limit: 25,
        });

        expect(page).toEqual({ chats: [{ ulid: 'c1' }], nextCursor: 'page-2' });

        const url = new URL(calls[0].url, 'http://x.test');

        expect(url.pathname).toBe('/api/v1/whatsapp/chats');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            status: 'open',
            session: 's1',
            linked: '0',
            unread: '1',
            q: 'invoice',
            sort: 'unread',
            cursor: 'page-1',
            limit: '25',
        });
    });

    it('leaves out the filters nobody set', async () => {
        const { api, calls } = clientWith(() => json({ data: [], meta: {} }));

        await api.chats({ q: '' });

        expect(calls[0].url).toBe('/api/v1/whatsapp/chats');
    });

    it('reads a transcript page and says there is more when the page is full or a cursor is given', async () => {
        const rows = [{ ulid: 'm1' }, { ulid: 'm2' }];
        const full = clientWith(() => json({ data: rows, meta: {} }));
        const short = clientWith(() => json({ data: rows, meta: {} }));

        await expect(
            full.api.messages('c1', { limit: 2, before: 'm9' }),
        ).resolves.toEqual({ messages: rows, hasMore: true });
        await expect(
            short.api.messages('c1', { limit: 50, after: 'm0' }),
        ).resolves.toEqual({ messages: rows, hasMore: false });
        expect(full.calls[0].url).toBe(
            '/api/v1/whatsapp/chats/c1/messages?before=m9&limit=2',
        );
        expect(short.calls[0].url).toBe(
            '/api/v1/whatsapp/chats/c1/messages?after=m0&limit=50',
        );
    });

    it('POSTs a reply with the client id and unwraps the stored message', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: { ulid: 'm1', status: 'pending' } }, 201),
        );

        await expect(
            api.sendMessage('c1', { clientMsgId: '01CLIENT', body: 'Hello' }),
        ).resolves.toEqual({ ulid: 'm1', status: 'pending' });
        expect(calls[0].init.method).toBe('POST');
        expect(bodyOf(calls[0])).toEqual({
            body: 'Hello',
            client_msg_id: '01CLIENT',
        });
    });

    it('marks read and archives through their own endpoints', async () => {
        const { api, calls } = clientWith(() => json({ data: null }));

        await api.markRead('c1');
        await api.archive('c1');
        await api.unarchive('c1');

        expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
            'POST /api/v1/whatsapp/chats/c1/read',
            'POST /api/v1/whatsapp/chats/c1/archive',
            'POST /api/v1/whatsapp/chats/c1/unarchive',
        ]);
    });
});

describe('the widget link', () => {
    it('reads and writes the session of a widget', async () => {
        const read = clientWith(() => json({ data: { session_ulid: 's1' } }));
        const written = clientWith(() =>
            json({ data: { session_ulid: null } }),
        );

        await expect(read.api.widgetWhatsApp('w1')).resolves.toEqual({
            sessionUlid: 's1',
        });
        await expect(
            written.api.setWidgetWhatsApp('w1', null),
        ).resolves.toEqual({ sessionUlid: null });
        expect(bodyOf(written.calls[0])).toEqual({ session_ulid: null });
        expect(written.calls[0].init.method).toBe('PUT');
    });
});

describe('errors', () => {
    const error = (code: string, status: number, retryAfter?: number) =>
        new ApiError({ status, code, message: 'server text', retryAfter });

    it('classifies the domain failures, whatever the case of the code', () => {
        expect(classifyWaError(error('session_not_ready', 409))).toBe(
            'session_not_ready',
        );
        expect(classifyWaError(error('daily_cap_reached', 429))).toBe(
            'daily_cap',
        );
        expect(classifyWaError(error('SEND_PACING_LIMITED', 429, 7200))).toBe(
            'pacing',
        );
        expect(
            classifyWaError(error('SESSION_NAME_TEARDOWN_PENDING', 409)),
        ).toBe('teardown_pending');
        expect(classifyWaError(error('session_name_taken', 409))).toBe(
            'name_taken',
        );
        expect(classifyWaError(error('webhook_rejected', 422))).toBe(
            'webhook_rejected',
        );
        expect(classifyWaError(error('whatever', 429))).toBe('rate_limited');
        expect(classifyWaError(error('whatever', 403))).toBe('forbidden');
        expect(classifyWaError(error('whatever', 500))).toBe('other');
        expect(classifyWaError(new Error('x'))).toBe('other');
    });

    it('turns every kind into a sentence a person can act on', () => {
        expect(describeWaError(error('session_not_ready', 409), t)).toMatch(
            /not connected/i,
        );
        expect(describeWaError(error('daily_cap_reached', 429), t)).toMatch(
            /daily/i,
        );
        expect(
            describeWaError(error('send_pacing_limited', 429, 7200), t),
        ).toMatch(/2 hours/);
        expect(describeWaError(error('send_pacing_limited', 429), t)).toMatch(
            /too fast/i,
        );
        expect(describeWaError(error('openwa_unavailable', 502), t)).toMatch(
            /reach/i,
        );
        expect(describeWaError(error('webhook_rejected', 422), t)).toContain(
            'SSRF_ALLOWED_HOSTS',
        );
        expect(
            describeWaError(error('session_name_teardown_pending', 409), t),
        ).toMatch(/wait/i);
        // Anything else goes through the shared texts.
        expect(describeWaError(error('server_error', 500), t)).toBe(
            t('widgets.api.error.server'),
        );
    });

    it('says waits in the unit a person reads', () => {
        expect(waitLabel(20)).toBe('20 seconds');
        expect(waitLabel(61)).toBe('2 minutes');
        expect(waitLabel(3600)).toBe('1 hour');
        expect(waitLabel(7201)).toBe('3 hours');
    });
});
