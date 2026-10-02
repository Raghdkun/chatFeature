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
    widgetLinkFromWire,
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
        expect(waRoutes.api.sessionSync('s1')).toBe(
            '/api/v1/whatsapp/sessions/s1/sync',
        );
        expect(waRoutes.api.chatMessages('01ABC')).toBe(
            '/api/v1/whatsapp/chats/01ABC/messages',
        );
        expect(waRoutes.api.connectionTest()).toBe(
            '/api/v1/whatsapp/settings/test',
        );
        expect(waRoutes.api.widgetWhatsApp('w1')).toBe(
            '/api/v1/widgets/w1/whatsapp',
        );
        expect(waRoutes.pages.chat('01ABC')).toBe('/whatsapp/chats/01ABC');
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
                baseUrl: 'https://openwa.example.com',
                hasApiKey: true,
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
        expect(settingsBody({ clearApiKey: true })).toEqual({
            clear_api_key: true,
        });
        expect(settingsBody({ ignoreGroups: false })).toEqual({
            ignore_groups: false,
        });
    });

    it('PUTs the body with the cookie headers and returns the parsed settings', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: { baseUrl: 'https://x.test', hasApiKey: true } }),
        );
        const saved = await api.saveSettings({
            baseUrl: 'https://x.test',
            apiKey: 'k',
        });

        expect(calls[0].url).toBe('/api/v1/whatsapp/settings');
        expect(calls[0].init.method).toBe('PUT');
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
    it('reads the role, the engine and whether the key may operate', () => {
        expect(
            connectionResultFromWire({
                ok: true,
                role: 'operator',
                engine: 'baileys',
                canOperate: true,
            }),
        ).toEqual({
            ok: true,
            role: 'operator',
            engine: 'baileys',
            canOperate: true,
        });
        expect(
            connectionResultFromWire({
                ok: false,
                reason: 'unauthorized',
                message: 'OpenWA refused the key.',
            }),
        ).toEqual({
            ok: false,
            reason: 'unauthorized',
            message: 'OpenWA refused the key.',
        });
    });

    it('asks the SAVED settings through POST settings/test', async () => {
        const { api, calls } = clientWith(() =>
            json({
                data: {
                    ok: true,
                    role: 'admin',
                    engine: 'x',
                    canOperate: true,
                },
            }),
        );

        await expect(api.testConnection()).resolves.toMatchObject({ ok: true });
        expect(calls[0].url).toBe('/api/v1/whatsapp/settings/test');
        expect(calls[0].init.method).toBe('POST');
    });

    it('turns an error answer about OpenWA into a result, not an exception', async () => {
        const { api } = clientWith(() =>
            json(
                { error: { code: 'openwa_unavailable', message: 'No route.' } },
                503,
            ),
        );

        await expect(api.testConnection()).resolves.toEqual({
            ok: false,
            reason: 'openwa_unavailable',
            message: 'No route.',
        });
    });

    it('still throws what is not about OpenWA: 403, the limiter, a server fault', async () => {
        for (const [status, code] of [
            [403, 'forbidden'],
            [429, 'rate_limited'],
            [500, 'server_error'],
        ] as const) {
            const { api } = clientWith(() =>
                json({ error: { code, message: 'No.' } }, status),
            );

            await expect(api.testConnection()).rejects.toBeInstanceOf(ApiError);
        }
    });
});

describe('QR', () => {
    it('keeps only a base64 PNG / JPEG data URL as the picture', () => {
        expect(
            qrFromWire({ qr: PNG, updatedAt: '2026-11-20T10:00:00Z' }),
        ).toEqual({
            status: 'qr',
            image: PNG,
            updatedAt: '2026-11-20T10:00:00Z',
        });
        expect(qrFromWire({ qr: 'https://evil.test/x.png' }).image).toBeNull();
        expect(
            qrFromWire({ qr: 'data:text/html;base64,PHNjcmlwdD4=' }).image,
        ).toBeNull();
        expect(
            qrFromWire({ qr: 'data:image/svg+xml;base64,PHN2Zz4=' }).image,
        ).toBeNull();
    });

    it('asks for the picture without any caching', async () => {
        const { api, calls } = clientWith(() =>
            json({ data: { qr: PNG, updatedAt: '2026-11-20T10:01:00Z' } }),
        );
        const qr = await api.qr('01SESSION');

        expect(calls[0].url).toBe('/api/v1/whatsapp/sessions/01SESSION/qr');
        expect(calls[0].init.cache).toBe('no-store');
        expect(qr).toMatchObject({ status: 'qr', image: PNG });
    });

    it('turns "no QR to scan" (409 qr_not_available) into the session status, so the dialog can follow it to ready', async () => {
        const { api } = clientWith(() =>
            json(
                {
                    error: {
                        code: 'qr_not_available',
                        message: 'No QR.',
                        details: { status: ['ready'] },
                    },
                },
                409,
            ),
        );

        await expect(api.qr('s1')).resolves.toEqual({
            status: 'ready',
            image: null,
            updatedAt: null,
        });
    });

    it('lets any other failure through', async () => {
        const { api } = clientWith(() =>
            json({ error: { code: 'openwa_unavailable', message: 'x' } }, 503),
        );

        await expect(api.qr('s1')).rejects.toBeInstanceOf(ApiError);
    });
});

describe('sessions', () => {
    it('creates, starts, stops and syncs through their own endpoints', async () => {
        const { api, calls } = clientWith(() => json({ data: { ulid: 's1' } }));

        await api.createSession('support-main');
        await api.startSession('s1');
        await api.stopSession('s1');
        await api.syncSession('s1');

        expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
            'POST /api/v1/whatsapp/sessions',
            'POST /api/v1/whatsapp/sessions/s1/start',
            'POST /api/v1/whatsapp/sessions/s1/stop',
            'POST /api/v1/whatsapp/sessions/s1/sync',
        ]);
        expect(bodyOf(calls[0])).toEqual({ name: 'support-main' });
    });

    it('deletes, and only deletes locally (force) when asked to', async () => {
        const { api, calls } = clientWith(
            () => new Response(null, { status: 204 }),
        );

        await api.deleteSession('s1');
        await api.deleteSession('s1', true);

        expect(calls.map((c) => c.url)).toEqual([
            '/api/v1/whatsapp/sessions/s1',
            '/api/v1/whatsapp/sessions/s1?force=1',
        ]);
    });

    it("changes a session's pacing, null going back to the global setting", async () => {
        const { api, calls } = clientWith(() => json({ data: { ulid: 's1' } }));

        await api.updateSessionPacing('s1', {
            sendMinIntervalMs: 3000,
            dailySendCap: null,
        });

        expect(calls[0].init.method).toBe('PATCH');
        expect(bodyOf(calls[0])).toEqual({
            send_min_interval_ms: 3000,
            daily_send_cap: null,
        });
    });
});

describe('chats and messages', () => {
    it('lists chats with the filters as query parameters and reads the cursor from the meta', async () => {
        const { api, calls } = clientWith(() =>
            json({
                data: [{ ulid: 'c1' }],
                meta: { next_cursor: 'page-2', unread_chats: 3 },
            }),
        );
        const page = await api.chats({
            status: 'open',
            session: 's1',
            widget: 'w1',
            category: 'sales',
            linked: false,
            unread: true,
            q: 'invoice',
            cursor: 'page-1',
            limit: 25,
        });

        expect(page).toEqual({ chats: [{ ulid: 'c1' }], nextCursor: 'page-2' });

        const url = new URL(calls[0].url, 'http://x.test');

        expect(url.pathname).toBe('/api/v1/whatsapp/chats');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            status: 'open',
            session: 's1',
            widget: 'w1',
            category: 'sales',
            linked: '0',
            unread: '1',
            q: 'invoice',
            cursor: 'page-1',
            limit: '25',
        });
    });

    it('leaves out the filters nobody set', async () => {
        const { api, calls } = clientWith(() => json({ data: [], meta: {} }));

        await api.chats({ q: '' });

        expect(calls[0].url).toBe('/api/v1/whatsapp/chats');
    });

    it('reads the newest transcript page: older rows exist while meta.prev_cursor is set', async () => {
        const rows = [{ ulid: 'm1' }, { ulid: 'm2' }];
        const more = clientWith(() =>
            json({
                data: rows,
                meta: { next_cursor: null, prev_cursor: 'm1' },
            }),
        );
        const all = clientWith(() =>
            json({
                data: rows,
                meta: { next_cursor: null, prev_cursor: null },
            }),
        );

        await expect(more.api.messages('c1')).resolves.toEqual({
            messages: rows,
            hasMore: true,
        });
        await expect(all.api.messages('c1')).resolves.toEqual({
            messages: rows,
            hasMore: false,
        });
        expect(more.calls[0].url).toBe(
            '/api/v1/whatsapp/chats/c1/messages?limit=100',
        );
    });

    it('pages backwards with before_id and forwards with after_id, each saying whether there is more that way', async () => {
        const rows = [{ ulid: 'm1' }];
        const back = clientWith(() =>
            json({
                data: rows,
                meta: { next_cursor: 'm1', prev_cursor: null },
            }),
        );
        const forward = clientWith(() =>
            json({
                data: rows,
                meta: { next_cursor: null, prev_cursor: 'm0' },
            }),
        );

        // Going back: the next cursor is irrelevant, only the previous one says there is older history.
        await expect(
            back.api.messages('c1', { before: 'm9', limit: 50 }),
        ).resolves.toEqual({ messages: rows, hasMore: false });
        // Going forward: only the next cursor counts.
        await expect(
            forward.api.messages('c1', { after: 'm0', limit: 50 }),
        ).resolves.toEqual({ messages: rows, hasMore: false });
        expect(back.calls[0].url).toBe(
            '/api/v1/whatsapp/chats/c1/messages?before_id=m9&limit=50',
        );
        expect(forward.calls[0].url).toBe(
            '/api/v1/whatsapp/chats/c1/messages?after_id=m0&limit=50',
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
    const link = {
        widget: { ulid: 'w1', name: 'Main site' },
        session: { ulid: 's1', name: 'support-main' },
        status: 'ready',
        maskedPhone: '+49•••••••4567',
        connected: true,
    };

    it('reads the session, its status, the masked number and whether it can serve', () => {
        expect(widgetLinkFromWire(link)).toEqual({
            session: { ulid: 's1', name: 'support-main' },
            status: 'ready',
            maskedPhone: '+49•••••••4567',
            connected: true,
        });
        expect(
            widgetLinkFromWire({ widget: link.widget, session: null }),
        ).toEqual({
            session: null,
            status: null,
            maskedPhone: null,
            connected: false,
        });
    });

    it('reads and writes the session of a widget', async () => {
        const read = clientWith(() => json({ data: link }));
        const written = clientWith(() =>
            json({ data: { ...link, session: null, connected: false } }),
        );

        await expect(read.api.widgetWhatsApp('w1')).resolves.toMatchObject({
            connected: true,
        });
        await expect(
            written.api.setWidgetWhatsApp('w1', null),
        ).resolves.toMatchObject({ session: null, connected: false });
        expect(bodyOf(written.calls[0])).toEqual({ session: null });
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
        expect(classifyWaError(error('reply_not_allowed', 409))).toBe(
            'not_inbound',
        );
        expect(
            classifyWaError(error('SESSION_NAME_TEARDOWN_PENDING', 409)),
        ).toBe('teardown_pending');
        expect(classifyWaError(error('session_name_taken', 409))).toBe(
            'name_taken',
        );
        expect(classifyWaError(error('openwa_session_exists', 409))).toBe(
            'name_taken',
        );
        expect(classifyWaError(error('webhook_rejected', 422))).toBe(
            'webhook_rejected',
        );
        expect(classifyWaError(error('openwa_rejected', 502))).toBe(
            'openwa_rejected',
        );
        expect(classifyWaError(error('session_not_startable', 409))).toBe(
            'session_state',
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
        expect(describeWaError(error('openwa_unavailable', 503), t)).toMatch(
            /reach/i,
        );
        expect(describeWaError(error('webhook_rejected', 422), t)).toContain(
            'SSRF_ALLOWED_HOSTS',
        );
        expect(
            describeWaError(error('session_name_teardown_pending', 409), t),
        ).toMatch(/wait/i);
        expect(describeWaError(error('session_not_startable', 409), t)).toMatch(
            /cannot be started or stopped/i,
        );
        expect(describeWaError(error('openwa_rejected', 502), t)).toMatch(
            /refused/i,
        );
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
