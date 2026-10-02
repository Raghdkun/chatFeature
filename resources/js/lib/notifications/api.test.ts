import { describe, expect, it } from 'vite-plus/test';
import { createNotificationsApi, settingsBody } from '@/lib/notifications/api';
import { createApiClient } from '@/lib/api-client';
import { notificationRoutes } from '@/lib/notifications/routes';
import { fakeApi } from '@/tests/fake-api';
import { deviceFixture, settingsFixture } from '@/tests/notifications-kit';

const php = import.meta.glob<string>(
    [
        '/routes/api/management/notifications.php',
        '/routes/web/notifications.php',
        '/config/push.php',
    ],
    { eager: true, query: '?raw', import: 'default' },
);

const source = (name: string): string => {
    const entry = Object.entries(php).find(([path]) => path.endsWith(name));

    if (!entry) {
        throw new Error(`PHP source not found: ${name}`);
    }

    return entry[1];
};

describe('notificationRoutes', () => {
    it('are the routes the server declares', () => {
        const api = source('api/management/notifications.php');

        expect(notificationRoutes.api.settings).toBe(
            '/api/v1/me/notification-settings',
        );
        expect(api).toContain("'me/notification-settings'");
        expect(notificationRoutes.api.subscriptions).toBe(
            '/api/v1/me/push-subscriptions',
        );
        expect(api).toContain("'me/push-subscriptions'");
        expect(notificationRoutes.api.test).toBe(
            '/api/v1/me/push-subscriptions/test',
        );
        expect(api).toContain("'me/push-subscriptions/test'");
        expect(notificationRoutes.api.subscription('01abc')).toBe(
            '/api/v1/me/push-subscriptions/01abc',
        );
        expect(api).toContain("'me/push-subscriptions/{subscription}'");
        expect(notificationRoutes.pages.settings).toBe(
            '/settings/notifications',
        );
        expect(source('web/notifications.php')).toContain(
            "'settings/notifications'",
        );
        expect(notificationRoutes.manifest).toBe('/manifest.webmanifest');
        expect(source('web/notifications.php')).toContain(
            "'manifest.webmanifest'",
        );
    });

    it('encodes the id in the URL', () => {
        expect(notificationRoutes.api.subscription('a/b')).toBe(
            '/api/v1/me/push-subscriptions/a%2Fb',
        );
    });

    it('agree with the default snooze of the first-login dialog', () => {
        expect(source('config/push.php')).toMatch(/'snooze_days' => 7,/);
    });
});

describe('settingsBody', () => {
    it('sends only what changed, in snake_case', () => {
        expect(settingsBody({})).toEqual({});
        expect(settingsBody({ sound: false })).toEqual({ sound: false });
        expect(
            settingsBody({
                pushOffers: true,
                pushMessages: false,
                includePreview: false,
                promptState: 'snoozed',
            }),
        ).toEqual({
            push_offers: true,
            push_messages: false,
            include_preview: false,
            prompt_state: 'snoozed',
        });
        expect(settingsBody({ quietHours: { end: '08:00' } })).toEqual({
            quiet_hours: { end: '08:00' },
        });
        expect(
            settingsBody({
                quietHours: {
                    enabled: true,
                    start: '22:30',
                    end: '06:00',
                    timezone: 'Asia/Riyadh',
                },
            }),
        ).toEqual({
            quiet_hours: {
                enabled: true,
                start: '22:30',
                end: '06:00',
                timezone: 'Asia/Riyadh',
            },
        });
    });
});

describe('the notifications api client', () => {
    function setup() {
        const server = fakeApi({
            'GET /api/v1/me/notification-settings': {
                json: { data: settingsFixture() },
            },
            'PUT /api/v1/me/notification-settings': {
                json: { data: settingsFixture({ sound: false }) },
            },
            'GET /api/v1/me/push-subscriptions': {
                json: { data: [deviceFixture()], meta: { next_cursor: null } },
            },
            'POST /api/v1/me/push-subscriptions': {
                status: 201,
                json: { data: deviceFixture() },
            },
            'DELETE /api/v1/me/push-subscriptions/01jdevice0000000000000000a': {
                status: 204,
            },
            'POST /api/v1/me/push-subscriptions/test': {
                json: { data: { devices: 1, sent: 1, failed: 0, removed: 0 } },
            },
        });

        return {
            server,
            api: createNotificationsApi(
                createApiClient({
                    xsrfToken: () => 'xsrf',
                    onUnauthenticated: () => undefined,
                    csrfCookieUrl: null,
                }),
            ),
        };
    }

    it('reads and saves the settings with the CSRF header', async () => {
        const { api, server } = setup();

        expect((await api.settings()).sound).toBe(true);
        expect((await api.updateSettings({ sound: false })).sound).toBe(false);
        expect(server.calls[1].method).toBe('PUT');
        expect(server.calls[1].body).toEqual({ sound: false });
        expect(server.calls[1].headers['X-XSRF-TOKEN']).toBe('xsrf');
    });

    it('lists, registers, removes and tests', async () => {
        const { api, server } = setup();

        expect(await api.devices()).toHaveLength(1);
        await api.register({
            endpoint: 'https://fcm.googleapis.com/x',
            keys: { p256dh: 'a', auth: 'b' },
        });
        expect(server.calls[1].body).toEqual({
            endpoint: 'https://fcm.googleapis.com/x',
            keys: { p256dh: 'a', auth: 'b' },
        });
        await api.remove('01jdevice0000000000000000a');
        expect((await api.test()).sent).toBe(1);
    });
});
