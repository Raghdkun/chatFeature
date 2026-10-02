/**
 * Accessibility of Settings > Notifications and the first-login dialog with axe-core in jsdom: names, labels, roles, ARIA validity
 * (colour contrast and target size need real layout and are left to the Playwright run), in LTR and RTL.
 */
import '@/tests/dom-polyfills';
import axe from 'axe-core';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NotificationPrompt } from '@/components/notifications/notification-prompt';
import { NotificationsContext } from '@/lib/notifications/context';
import { createNotificationsController } from '@/lib/notifications/controller';
import Notifications from '@/pages/settings/notifications';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { en } from '@/tests/lang';
import {
    deviceFixture,
    fakeEnv,
    fakeNotificationsApi,
    fakeStorage,
    fakeSubscription,
    VAPID_KEY,
} from '@/tests/notifications-kit';
import { render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

vi.setConfig({ testTimeout: 20_000 });

async function violations(root: Element = document.body): Promise<string[]> {
    const result = await axe.run(root, {
        rules: {
            'color-contrast': { enabled: false },
            'target-size': { enabled: false },
            region: { enabled: false },
            'landmark-one-main': { enabled: false },
            'page-has-heading-one': { enabled: false },
        },
    });

    return result.violations.map(
        (violation) =>
            `${violation.id}: ${violation.help} (${violation.nodes
                .slice(0, 3)
                .map((node) => node.target.join(' '))
                .join(' | ')})`,
    );
}

async function controllerFor(
    options: Parameters<typeof fakeEnv>[0] = {},
    settings = {},
) {
    const controller = createNotificationsController({
        userId: 7,
        vapidPublicKey: VAPID_KEY,
        api: fakeNotificationsApi({
            settings,
            devices: [
                deviceFixture({
                    id: '01jmine',
                    endpointHash:
                        'sha256(https://fcm.googleapis.com/fcm/send/this-browser)',
                }),
                deviceFixture({
                    id: '01jother',
                    label: 'Firefox on Windows',
                    endpointHash: 'other',
                    lastUsedAt: '2026-11-20T10:00:00.000Z',
                }),
            ],
        }),
        env: fakeEnv(options),
        storage: fakeStorage(),
        promptDelayMs: 0,
    });

    await act(async () => {
        await controller.start();
        await new Promise((resolve) => setTimeout(resolve, 5));
    });

    return controller;
}

beforeEach(() => resetInertiaMock({ locale: 'en' }));

describe('Settings > Notifications', () => {
    it.each([
        [
            'an enabled browser with devices',
            {
                permission: 'granted' as const,
                subscription: fakeSubscription(),
            },
            {},
        ],
        ['a browser that was never asked', {}, {}],
        ['a blocked site', { permission: 'denied' as const }, {}],
        [
            'a browser that cannot do push',
            {
                support: {
                    supported: false,
                    reason: 'ios-needs-install',
                } as const,
            },
            {},
        ],
        [
            'quiet hours switched on (an overnight window)',
            { permission: 'granted' as const },
            {
                quietHours: {
                    enabled: true,
                    start: '22:00',
                    end: '07:00',
                    timezone: 'Asia/Riyadh',
                },
            },
        ],
        [
            'previews switched off by an administrator',
            {},
            { previewsAllowed: false },
        ],
    ])('has no structural violations for %s', async (_label, env, settings) => {
        const controller = await controllerFor(env, settings);
        const view = await render(
            <NotificationsContext.Provider value={controller}>
                <Notifications />
            </NotificationsContext.Provider>,
        );

        expect(await violations(view.container)).toEqual([]);
    });

    it('has none in a right-to-left language either', async () => {
        resetInertiaMock({ locale: 'ar', direction: 'rtl' });
        document.documentElement.dir = 'rtl';
        const controller = await controllerFor({ permission: 'granted' });
        const view = await render(
            <NotificationsContext.Provider value={controller}>
                <Notifications />
            </NotificationsContext.Provider>,
        );

        try {
            expect(await violations(view.container)).toEqual([]);
        } finally {
            document.documentElement.dir = 'ltr';
        }
    });
});

describe('the first-login dialog', () => {
    it('has no structural violations while open', async () => {
        const controller = await controllerFor();
        await render(
            <NotificationPrompt
                controller={controller}
                t={(key) => en[key] ?? key}
            />,
        );

        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(await violations()).toEqual([]);
    });
});
