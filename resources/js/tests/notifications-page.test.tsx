import '@/tests/dom-polyfills';
import { act } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api-client';
import { NotificationsContext } from '@/lib/notifications/context';
import { createNotificationsController } from '@/lib/notifications/controller';
import Notifications from '@/pages/settings/notifications';
import { byLabelText, choose } from '@/tests/dom';
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
import { click, render, typeInto } from '@/tests/render';

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

type SceneOptions = {
    env?: Parameters<typeof fakeEnv>[0];
    api?: Parameters<typeof fakeNotificationsApi>[0];
    vapid?: string | null;
    start?: boolean;
    storage?: Record<string, string>;
};

async function mount(options: SceneOptions = {}) {
    const env = fakeEnv(options.env);
    const api = fakeNotificationsApi(options.api);
    const sound: boolean[] = [];
    const controller = createNotificationsController({
        userId: 7,
        vapidPublicKey: options.vapid === undefined ? VAPID_KEY : options.vapid,
        api,
        env,
        storage: fakeStorage(options.storage),
        promptDelayMs: 60_000,
        onSoundToggle: (on) => sound.push(on),
    });

    if (options.start !== false) {
        await act(async () => {
            await controller.start();
        });
    }

    const view = await render(
        <NotificationsContext.Provider value={controller}>
            <Notifications />
        </NotificationsContext.Provider>,
    );

    return { env, api, controller, view, sound };
}

const get = (
    view: { byTestId: (id: string) => HTMLElement | null },
    id: string,
) => view.byTestId(id);
const status = (view: { byTestId: (id: string) => HTMLElement | null }) =>
    view.byTestId('notifications-status')?.textContent ?? '';

beforeEach(() => {
    resetInertiaMock({ locale: 'en' });
    vi.clearAllMocks();
});

afterEach(() => vi.clearAllMocks());

describe('loading', () => {
    it('shows a placeholder until the settings arrive, and a retry when they cannot be loaded', async () => {
        const { view, controller, api } = await mount({ start: false });

        expect(get(view, 'notifications-loading')?.getAttribute('role')).toBe(
            'status',
        );
        expect(get(view, 'notifications-browser')).toBeNull();

        api.settings.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );
        await act(async () => {
            await controller.start();
        });
        expect(get(view, 'notifications-error')?.textContent).toContain(
            en['notifications.settings.load_failed'],
        );

        await click(
            get(view, 'notifications-error')?.querySelector('button') ?? null,
        );

        expect(get(view, 'notifications-error')).toBeNull();
        expect(get(view, 'notifications-browser')).not.toBeNull();
    });

    it('has one h1 and the section headings', async () => {
        const { view } = await mount();

        expect(view.container.querySelectorAll('h1')).toHaveLength(1);
        expect(view.container.querySelector('h1')?.textContent).toBe(
            en['notifications.settings.head'],
        );
        expect(
            Array.from(view.container.querySelectorAll('h2')).map(
                (h) => h.textContent,
            ),
        ).toEqual(
            expect.arrayContaining([
                en['notifications.settings.title'],
                en['notifications.browser.title'],
                en['notifications.prefs.title'],
                en['notifications.quiet.title'],
                en['notifications.devices.title'],
            ]),
        );
    });
});

describe('this browser', () => {
    it('invites a browser that has not been asked to turn notifications on, and only then asks', async () => {
        const { view, env, controller } = await mount();

        expect(status(view)).toContain(en['notifications.status.off']);
        expect(get(view, 'notifications-test')).toBeNull();
        expect(env.requestPermission).not.toHaveBeenCalled();

        await click(get(view, 'notifications-enable'));

        expect(env.requestPermission).toHaveBeenCalledTimes(1);
        expect(controller.getState().subscribed).toBe(true);
        expect(status(view)).toContain(en['notifications.status.on']);
        expect(get(view, 'notifications-test')).not.toBeNull();
        expect(get(view, 'notifications-disable')).not.toBeNull();
        expect(get(view, 'notifications-enable')).toBeNull();
        expect(toast.success).toHaveBeenCalledWith(
            en['notifications.prompt.enabled'],
        );
    });

    it('shows the on state at once when the browser is already subscribed', async () => {
        const { view } = await mount({ env: { permission: 'granted' } });

        expect(status(view)).toContain(en['notifications.status.on']);
    });

    it('explains how to unblock a site that was blocked, and offers no button that cannot work', async () => {
        const { view } = await mount({ env: { permission: 'denied' } });

        expect(status(view)).toContain(en['notifications.status.denied']);
        expect(status(view)).toContain(en['notifications.status.denied_help']);
        expect(get(view, 'notifications-enable')).toBeNull();
        expect(get(view, 'notifications-test')).toBeNull();
    });

    it.each([
        ['ios-needs-install', 'notifications.status.ios_needs_install'],
        ['insecure', 'notifications.status.insecure'],
        ['no-push', 'notifications.status.no_push'],
    ] as const)(
        'says why a browser cannot do push (%s) and what it gets instead',
        async (reason, key) => {
            const { view } = await mount({
                env: { support: { supported: false, reason } },
            });

            expect(status(view)).toContain(en[key]);
            expect(status(view)).toContain(en['notifications.status.fallback']);
            expect(get(view, 'notifications-enable')).toBeNull();
        },
    );

    it('says when the server has no push keys', async () => {
        const { view } = await mount({ vapid: null });

        expect(status(view)).toContain(en['notifications.status.unavailable']);
        expect(get(view, 'notifications-enable')).toBeNull();
    });

    it('remembers that the person turned it off here', async () => {
        const { view } = await mount({
            env: { permission: 'granted' },
            storage: { 'pne.notifications.off.7': '1' },
        });

        expect(status(view)).toContain(en['notifications.status.off_here']);
        expect(get(view, 'notifications-enable')).not.toBeNull();
    });

    it('turns it off for this browser', async () => {
        const { view, env, api } = await mount({
            env: { permission: 'granted' },
        });
        const subscription = env.subscription!;

        await click(get(view, 'notifications-disable'));

        expect(subscription.unsubscribe).toHaveBeenCalled();
        expect(api.devicesState).toHaveLength(0);
        expect(status(view)).toContain(en['notifications.status.off_here']);
    });
});

describe('send a test notification', () => {
    it('announces the answer in a polite live region', async () => {
        const { view } = await mount({ env: { permission: 'granted' } });
        const region = get(view, 'notifications-test-result');

        expect(region?.getAttribute('role')).toBe('status');
        expect(region?.getAttribute('aria-live')).toBe('polite');

        await click(get(view, 'notifications-test'));

        expect(region?.textContent).toContain(
            en['notifications.test.sent_one'],
        );
    });

    it.each([
        [
            new ApiError({
                status: 409,
                code: 'no_push_devices',
                message: 'x',
            }),
            'notifications.test.none',
        ],
        [
            new ApiError({
                status: 503,
                code: 'push_unavailable',
                message: 'x',
            }),
            'notifications.test.unavailable',
        ],
        [
            new ApiError({ status: 0, code: 'network', message: 'x' }),
            'notifications.test.failed',
        ],
    ])('explains a failure (%#)', async (error, key) => {
        const { view, api } = await mount({ env: { permission: 'granted' } });
        api.test.mockRejectedValue(error);

        await click(get(view, 'notifications-test'));

        expect(get(view, 'notifications-test-result')?.textContent).toContain(
            en[key],
        );
    });

    it('explains the rate limit with the time to wait', async () => {
        const { view, api } = await mount({ env: { permission: 'granted' } });
        api.test.mockRejectedValue(
            new ApiError({
                status: 429,
                code: 'rate_limited',
                message: 'x',
                retryAfter: 40,
            }),
        );

        await click(get(view, 'notifications-test'));

        expect(get(view, 'notifications-test-result')?.textContent).toContain(
            '40 seconds',
        );
    });

    it('is disabled while it is sending', async () => {
        const { view, api } = await mount({ env: { permission: 'granted' } });
        let finish: () => void = () => undefined;
        api.test.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = () =>
                        resolve({ devices: 1, sent: 1, failed: 0, removed: 0 });
                }),
        );

        await click(get(view, 'notifications-test'));

        expect(
            (get(view, 'notifications-test') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(get(view, 'notifications-test')?.textContent).toContain(
            en['notifications.action.testing'],
        );

        await act(async () => {
            finish();
        });
        expect(
            (get(view, 'notifications-test') as HTMLButtonElement).disabled,
        ).toBe(false);
    });
});

describe('preferences', () => {
    it('has a labelled switch for each choice, reflecting what is saved', async () => {
        const { view } = await mount({
            api: {
                settings: {
                    sound: true,
                    pushOffers: false,
                    pushMessages: true,
                    includePreview: false,
                },
            },
        });

        const sound = byLabelText(
            view.container,
            en['notifications.prefs.sound'],
        );
        const offers = byLabelText(
            view.container,
            en['notifications.prefs.offers'],
        );
        const messages = byLabelText(
            view.container,
            en['notifications.prefs.messages'],
        );
        const preview = byLabelText(
            view.container,
            en['notifications.prefs.preview'],
        );

        expect(
            [sound, offers, messages, preview].every(
                (control) => control?.getAttribute('role') === 'switch',
            ),
        ).toBe(true);
        expect(
            [sound, offers, messages, preview].map((control) =>
                control?.getAttribute('aria-checked'),
            ),
        ).toEqual(['true', 'false', 'true', 'false']);
        expect(sound?.getAttribute('aria-describedby')).toBeTruthy();
    });

    it.each([
        ['notifications-sound', { sound: false }],
        ['notifications-offers', { pushOffers: false }],
        ['notifications-messages', { pushMessages: false }],
        ['notifications-preview', { includePreview: false }],
    ])('saves %s as it is flipped', async (id, patch) => {
        const { view, api } = await mount();

        await click(get(view, id));

        expect(api.updateSettings).toHaveBeenCalledWith(patch);
    });

    it('lets the sound player follow the sound switch', async () => {
        const { view, sound } = await mount();

        await click(get(view, 'notifications-sound'));
        await click(get(view, 'notifications-sound'));

        expect(sound).toEqual([false, true]);
    });

    it('puts the switch back and says so when the save fails', async () => {
        const { view, api } = await mount();
        api.updateSettings.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );

        await click(get(view, 'notifications-offers'));

        expect(
            get(view, 'notifications-offers')?.getAttribute('aria-checked'),
        ).toBe('true');
        expect(toast.error).toHaveBeenCalledWith(
            en['notifications.settings.save_failed'],
        );
    });

    it('locks the preview switch off when an administrator disabled previews for everyone', async () => {
        const { view, api } = await mount({
            api: { settings: { previewsAllowed: false, includePreview: true } },
        });
        const preview = get(view, 'notifications-preview') as HTMLButtonElement;

        expect(preview.disabled).toBe(true);
        expect(preview.getAttribute('aria-checked')).toBe('false');
        expect(view.text()).toContain(en['notifications.prefs.preview_locked']);
        await click(preview);
        expect(api.updateSettings).not.toHaveBeenCalled();
    });
});

describe('quiet hours', () => {
    it('keeps the times disabled until the window is switched on, then saves each change', async () => {
        const { view, api } = await mount();
        const start = get(
            view,
            'notifications-quiet-start',
        ) as HTMLInputElement;
        const end = get(view, 'notifications-quiet-end') as HTMLInputElement;

        expect(start.disabled).toBe(true);
        expect(end.disabled).toBe(true);

        await click(get(view, 'notifications-quiet-enabled'));
        expect(api.updateSettings).toHaveBeenLastCalledWith({
            quietHours: { enabled: true },
        });
        expect(start.disabled).toBe(false);

        await typeInto(start, '23:30');
        expect(api.updateSettings).toHaveBeenLastCalledWith({
            quietHours: { start: '23:30' },
        });
        await typeInto(end, '06:15');
        expect(api.updateSettings).toHaveBeenLastCalledWith({
            quietHours: { end: '06:15' },
        });
    });

    it('has labelled fields and a time zone select', async () => {
        const { view, api } = await mount({
            api: {
                settings: {
                    quietHours: {
                        enabled: true,
                        start: '22:00',
                        end: '07:00',
                        timezone: 'UTC',
                    },
                },
            },
        });

        expect(
            byLabelText(view.container, en['notifications.quiet.start']),
        ).not.toBeNull();
        expect(
            byLabelText(view.container, en['notifications.quiet.end']),
        ).not.toBeNull();

        const zone = byLabelText<HTMLSelectElement>(
            view.container,
            en['notifications.quiet.timezone'],
        );
        expect(zone?.value).toBe('UTC');
        await choose(zone, 'Asia/Riyadh');
        expect(api.updateSettings).toHaveBeenLastCalledWith({
            quietHours: { timezone: 'Asia/Riyadh' },
        });
    });

    it('says when the window runs overnight', async () => {
        const { view } = await mount({
            api: {
                settings: {
                    quietHours: {
                        enabled: true,
                        start: '22:00',
                        end: '07:00',
                        timezone: 'UTC',
                    },
                },
            },
        });

        expect(view.text()).toContain(en['notifications.quiet.overnight']);
    });

    it('refuses equal start and end times without saving', async () => {
        const { view, api } = await mount({
            api: {
                settings: {
                    quietHours: {
                        enabled: true,
                        start: '22:00',
                        end: '07:00',
                        timezone: 'UTC',
                    },
                },
            },
        });

        await typeInto(
            get(view, 'notifications-quiet-start') as HTMLInputElement,
            '07:00',
        );

        expect(api.updateSettings).not.toHaveBeenCalled();
        expect(view.text()).toContain(en['notifications.quiet.same_time']);
        expect(
            get(view, 'notifications-quiet-end')?.getAttribute('aria-invalid'),
        ).toBe('true');
        expect(
            get(view, 'notifications-quiet-end')?.getAttribute(
                'aria-describedby',
            ),
        ).toContain('notifications-quiet-end-error');
    });
});

describe('devices', () => {
    it('lists the registered browsers, marks this one and names each remove button', async () => {
        const mine = deviceFixture({
            id: '01jmine',
            label: 'Chrome on macOS',
            endpointHash:
                'sha256(https://fcm.googleapis.com/fcm/send/this-browser)',
            lastUsedAt: '2026-11-20T10:00:00.000Z',
        });
        const other = deviceFixture({
            id: '01jother',
            label: 'Firefox on Windows',
            endpointHash: 'other',
        });
        const { view } = await mount({
            env: { permission: 'granted', subscription: fakeSubscription() },
            api: { devices: [mine, other] },
        });

        const rows = view.allByTestId('notifications-device');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain(en['notifications.devices.this']);
        expect(rows[1].textContent).not.toContain(
            en['notifications.devices.this'],
        );
        expect(rows[1].textContent).toContain(
            en['notifications.devices.never_used'],
        );
        expect(rows[0].textContent).toContain('Last notified');
        expect(
            rows[1].querySelector('button')?.getAttribute('aria-label'),
        ).toBe('Remove Firefox on Windows');
    });

    it('says when there is none', async () => {
        const { view } = await mount({ env: { permission: 'denied' } });

        expect(get(view, 'notifications-devices-empty')?.textContent).toBe(
            en['notifications.devices.empty'],
        );
    });

    it("lists the account's browsers even in one that cannot do push (to remove the desktop from a phone)", async () => {
        const other = deviceFixture({
            id: '01jother',
            label: 'Firefox on Windows',
            endpointHash: 'other',
        });
        const { view } = await mount({
            env: { support: { supported: false, reason: 'ios-needs-install' } },
            api: { devices: [other] },
        });

        expect(view.allByTestId('notifications-device')).toHaveLength(1);
        expect(
            view.allByTestId('notifications-device')[0].textContent,
        ).not.toContain(en['notifications.devices.this']);
    });

    it('removes a browser and confirms it', async () => {
        const mine = deviceFixture({
            id: '01jmine',
            endpointHash:
                'sha256(https://fcm.googleapis.com/fcm/send/this-browser)',
        });
        const other = deviceFixture({
            id: '01jother',
            label: 'Firefox on Windows',
            endpointHash: 'other',
        });
        const { view, api } = await mount({
            env: { permission: 'granted', subscription: fakeSubscription() },
            api: { devices: [mine, other] },
        });

        await click(view.allByTestId('notifications-device-remove')[1]);

        expect(api.remove).toHaveBeenCalledWith('01jother');
        expect(toast.success).toHaveBeenCalledWith(
            en['notifications.devices.removed'],
        );
        expect(view.allByTestId('notifications-device')).toHaveLength(1);
    });

    it('says so when a removal fails and keeps the row', async () => {
        const mine = deviceFixture({
            id: '01jmine',
            endpointHash:
                'sha256(https://fcm.googleapis.com/fcm/send/this-browser)',
        });
        const other = deviceFixture({
            id: '01jother',
            label: 'Firefox on Windows',
            endpointHash: 'other',
        });
        const { view, api } = await mount({
            env: { permission: 'granted', subscription: fakeSubscription() },
            api: { devices: [mine, other] },
        });
        api.remove.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );

        await click(view.allByTestId('notifications-device-remove')[1]);

        expect(toast.error).toHaveBeenCalledWith(
            en['notifications.devices.remove_failed'],
        );
        expect(view.allByTestId('notifications-device')).toHaveLength(2);
    });

    it('removing this browser turns it off here too', async () => {
        const { view, controller } = await mount({
            env: { permission: 'granted' },
        });
        const row = view.allByTestId('notifications-device')[0];

        expect(row.textContent).toContain(en['notifications.devices.this']);
        await click(row.querySelector('button'));

        expect(controller.getState()).toMatchObject({
            subscribed: false,
            offHere: true,
        });
        expect(status(view)).toContain(en['notifications.status.off_here']);
    });
});
