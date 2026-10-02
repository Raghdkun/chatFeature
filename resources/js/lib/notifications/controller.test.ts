import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ApiError } from '@/lib/api-client';
import { applicationServerKey } from '@/lib/notifications/browser';
import {
    createNotificationsController,
    openablePath,
    osPreferencesOf,
    type NotificationsDeps,
} from '@/lib/notifications/controller';
import {
    deviceFixture,
    fakeEnv,
    settingsFixture,
    fakeNotificationsApi,
    fakeStorage,
    fakeSubscription,
    VAPID_KEY,
    type FakeEnv,
    type FakeNotificationsApi,
} from '@/tests/notifications-kit';

const NOW = Date.parse('2026-11-20T12:00:00Z');

type Rig = {
    env: FakeEnv;
    api: FakeNotificationsApi;
    storage: ReturnType<typeof fakeStorage>;
    deps: NotificationsDeps;
    errors: unknown[];
    sound: { preference: boolean[]; toggle: boolean[] };
    opened: string[];
};

function rig(
    options: {
        env?: Parameters<typeof fakeEnv>[0];
        api?: Parameters<typeof fakeNotificationsApi>[0];
        storage?: Record<string, string>;
        vapid?: string | null;
        deps?: Partial<NotificationsDeps>;
    } = {},
) {
    const env = fakeEnv(options.env);
    const api = fakeNotificationsApi(options.api);
    const storage = fakeStorage(options.storage);
    const errors: unknown[] = [];
    const sound = { preference: [] as boolean[], toggle: [] as boolean[] };
    const opened: string[] = [];
    const deps: NotificationsDeps = {
        userId: 7,
        vapidPublicKey: options.vapid === undefined ? VAPID_KEY : options.vapid,
        api,
        env,
        storage,
        now: () => NOW,
        promptDelayMs: 1_500,
        onSoundPreference: (on) => sound.preference.push(on),
        onSoundToggle: (on) => sound.toggle.push(on),
        onOpen: (path) => opened.push(path),
        onError: (error) => errors.push(error),
        ...options.deps,
    };

    return {
        env,
        api,
        storage,
        deps,
        errors,
        sound,
        opened,
        make: () => createNotificationsController(deps),
    } satisfies Omit<Rig, 'deps'> & {
        deps: NotificationsDeps;
        make: () => unknown;
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('start: the page opens', () => {
    it('loads the settings and tells the sound player what the server says', async () => {
        const r = rig({ api: { settings: { sound: false } } });
        const controller = r.make();

        await controller.start();

        expect(controller.getState().settings?.sound).toBe(false);
        expect(controller.getState().settingsStatus).toBe('ready');
        expect(r.sound.preference).toEqual([false]);
    });

    it('NEVER asks the browser for permission by itself', async () => {
        const r = rig();
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(r.env.requestPermission).not.toHaveBeenCalled();
        expect(r.env.registerWorker).not.toHaveBeenCalled();
        expect(r.env.subscribe).not.toHaveBeenCalled();
    });

    it('opens the explainer after a short delay for a member who was never asked', async () => {
        const r = rig();
        const controller = r.make();

        await controller.start();
        expect(controller.getState().promptOpen).toBe(false);

        await vi.advanceTimersByTimeAsync(1_499);
        expect(controller.getState().promptOpen).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.getState().promptOpen).toBe(true);
    });

    it('never opens the explainer for an account that does not take chats (only agents are pushed)', async () => {
        const r = rig({ deps: { isAgent: false } });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().promptOpen).toBe(false);
        // The settings page still works for them: nothing was asked, nothing was blocked.
        expect(controller.getState().settingsStatus).toBe('ready');
    });

    it.each([
        [
            'an active snooze',
            {
                promptState: 'snoozed' as const,
                snoozedUntil: '2026-11-27T12:00:00Z',
            },
        ],
        ['a previous refusal', { promptState: 'denied' as const }],
        ['a previous yes', { promptState: 'granted' as const }],
    ])('does not open the explainer after %s', async (_label, settings) => {
        const r = rig({ api: { settings } });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().promptOpen).toBe(false);
    });

    it('opens it again once a snooze has run out', async () => {
        const r = rig({
            api: {
                settings: {
                    promptState: 'snoozed',
                    snoozedUntil: '2026-11-19T12:00:00Z',
                },
            },
        });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(1_500);

        expect(controller.getState().promptOpen).toBe(true);
    });

    it('does not open it when the permission is already decided in the browser', async () => {
        for (const permission of ['granted', 'denied'] as const) {
            const r = rig({
                env: { permission, subscription: fakeSubscription() },
            });
            const controller = r.make();

            await controller.start();
            await vi.advanceTimersByTimeAsync(10_000);

            expect(controller.getState().promptOpen).toBe(false);
        }
    });

    it('does nothing about push in a browser that cannot do it (the dashboard keeps its toast, sound and title badge)', async () => {
        const r = rig({
            env: { support: { supported: false, reason: 'no-push' } },
        });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().permission).toBe('unsupported');
        expect(controller.getState().promptOpen).toBe(false);
        expect(r.env.registerWorker).not.toHaveBeenCalled();
        expect(r.env.workerListeners).toBe(0);
        // The settings still load: the sound preference applies everywhere.
        expect(controller.getState().settings).not.toBeNull();
    });

    it('does nothing about push when the server has no VAPID key (the shared prop is null)', async () => {
        const r = rig({ vapid: null });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().pushConfigured).toBe(false);
        expect(controller.getState().promptOpen).toBe(false);
        expect(r.env.registerWorker).not.toHaveBeenCalled();
    });

    it('does nothing about push when the server says it is not available', async () => {
        const r = rig({ api: { settings: { pushAvailable: false } } });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().promptOpen).toBe(false);
    });

    it('starts only once', async () => {
        const r = rig();
        const controller = r.make();

        await controller.start();
        await controller.start();

        expect(r.api.settings).toHaveBeenCalledTimes(1);
    });

    it('survives settings that cannot be loaded (no prompt, an error state, the failure reported)', async () => {
        const r = rig();
        r.api.settings.mockRejectedValue(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().settingsStatus).toBe('error');
        expect(controller.getState().promptOpen).toBe(false);
        expect(r.errors).toHaveLength(1);

        r.api.settings.mockResolvedValue(r.api.settingsState);
        await controller.loadSettings();
        expect(controller.getState().settingsStatus).toBe('ready');
    });
});

describe('start: permission already granted', () => {
    it('registers the worker, subscribes with the server key and registers the browser (an upsert)', async () => {
        const r = rig({ env: { permission: 'granted' } });
        const controller = r.make();

        await controller.start();

        expect(r.env.registerWorker).toHaveBeenCalledTimes(1);
        expect(r.env.subscribe).toHaveBeenCalledTimes(1);
        expect(r.env.subscribe.mock.calls[0][0]).toEqual(
            applicationServerKey(VAPID_KEY),
        );
        expect(r.api.register).toHaveBeenCalledTimes(1);
        expect(r.api.register.mock.calls[0][0].endpoint).toBe(
            'https://fcm.googleapis.com/fcm/send/this-browser',
        );
        expect(controller.getState().subscribed).toBe(true);
        expect(controller.getState().thisDeviceHash).toBe(
            'sha256(https://fcm.googleapis.com/fcm/send/this-browser)',
        );
        expect(controller.getState().devices).toHaveLength(1);
    });

    it('reuses a subscription that was made with the current key and registers it again (refreshing its session)', async () => {
        const existing = fakeSubscription(
            'https://fcm.googleapis.com/fcm/send/existing',
            applicationServerKey(VAPID_KEY).buffer,
        );
        const r = rig({
            env: { permission: 'granted', subscription: existing },
        });
        const controller = r.make();

        await controller.start();

        expect(r.env.subscribe).not.toHaveBeenCalled();
        expect(existing.unsubscribe).not.toHaveBeenCalled();
        expect(r.api.register).toHaveBeenCalledTimes(1);
    });

    it('subscribes again when the server key changed and removes the old browser row', async () => {
        const stale = fakeSubscription(
            'https://fcm.googleapis.com/fcm/send/old',
            new Uint8Array([1, 2, 3]).buffer,
        );
        const oldRow = deviceFixture({
            id: '01jolddevice',
            endpointHash: 'sha256(https://fcm.googleapis.com/fcm/send/old)',
        });
        const r = rig({
            env: { permission: 'granted', subscription: stale },
            api: { devices: [oldRow] },
        });
        const controller = r.make();

        await controller.start();

        expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
        expect(r.env.subscribe).toHaveBeenCalledTimes(1);
        expect(r.api.remove).toHaveBeenCalledWith('01jolddevice');
        expect(
            controller.getState().devices?.map((device) => device.id),
        ).not.toContain('01jolddevice');
        expect(controller.getState().subscribed).toBe(true);
    });

    it('records a "granted" the server did not know yet, once', async () => {
        const r = rig({ env: { permission: 'granted' } });
        const controller = r.make();

        await controller.start();

        expect(r.api.updateSettings).toHaveBeenCalledWith({
            promptState: 'granted',
        });
        expect(controller.getState().settings?.promptState).toBe('granted');

        const again = rig({
            env: { permission: 'granted' },
            api: { settings: { promptState: 'granted' } },
        });
        await again.make().start();
        expect(again.api.updateSettings).not.toHaveBeenCalled();
    });

    it('does not subscribe a browser the person turned off, and does not nag them', async () => {
        const r = rig({
            env: { permission: 'granted' },
            storage: { 'pne.notifications.off.7': '1' },
        });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(controller.getState().offHere).toBe(true);
        expect(r.env.registerWorker).not.toHaveBeenCalled();
        expect(controller.getState().subscribed).toBe(false);
        expect(controller.getState().promptOpen).toBe(false);
    });

    it('reports a failed subscription instead of throwing, and stays unsubscribed', async () => {
        const r = rig({ env: { permission: 'granted' } });
        r.env.subscribe.mockRejectedValue(
            new Error('push service unreachable'),
        );
        const controller = r.make();

        await controller.start();

        expect(controller.getState().subscribed).toBe(false);
        expect(r.errors).toHaveLength(1);
    });
});

describe('start: permission blocked', () => {
    it('records the refusal once so the settings page can explain it', async () => {
        const r = rig({ env: { permission: 'denied' } });
        const controller = r.make();

        await controller.start();

        expect(r.api.updateSettings).toHaveBeenCalledWith({
            promptState: 'denied',
        });
        expect(r.env.registerWorker).not.toHaveBeenCalled();
        expect(controller.getState().promptOpen).toBe(false);
    });
});

describe('enable: the button was pressed', () => {
    it('asks the browser, subscribes, registers and records the yes', async () => {
        const r = rig({ env: { promptAnswer: 'granted' } });
        const controller = r.make();

        await controller.start();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(controller.getState().promptOpen).toBe(true);

        const result = await controller.enable();

        expect(result).toBe('enabled');
        expect(r.env.requestPermission).toHaveBeenCalledTimes(1);
        expect(r.env.subscribe).toHaveBeenCalledTimes(1);
        expect(r.api.register).toHaveBeenCalledTimes(1);
        expect(r.api.updateSettings).toHaveBeenLastCalledWith({
            promptState: 'granted',
        });
        expect(controller.getState()).toMatchObject({
            permission: 'granted',
            subscribed: true,
            promptOpen: false,
            busy: null,
        });
    });

    it('records a refusal ("denied") and does not subscribe', async () => {
        const r = rig({ env: { promptAnswer: 'denied' } });
        const controller = r.make();
        await controller.start();

        expect(await controller.enable()).toBe('denied');

        expect(r.env.subscribe).not.toHaveBeenCalled();
        expect(r.api.updateSettings).toHaveBeenLastCalledWith({
            promptState: 'denied',
        });
        expect(controller.getState().permission).toBe('denied');
    });

    it('treats a prompt closed without an answer as "not now" (snoozed)', async () => {
        const r = rig({ env: { promptAnswer: 'default' } });
        const controller = r.make();
        await controller.start();

        expect(await controller.enable()).toBe('dismissed');

        expect(r.api.updateSettings).toHaveBeenLastCalledWith({
            promptState: 'snoozed',
        });
        expect(controller.getState().settings?.promptState).toBe('snoozed');
    });

    it('answers "failed" when the subscription cannot be made after a yes', async () => {
        const r = rig({ env: { promptAnswer: 'granted' } });
        r.env.subscribe.mockRejectedValue(new Error('boom'));
        const controller = r.make();
        await controller.start();

        expect(await controller.enable()).toBe('failed');
        expect(controller.getState().busy).toBeNull();
        expect(controller.getState().promptOpen).toBe(false);
    });

    it('clears the "turned off here" choice', async () => {
        const r = rig({ storage: { 'pne.notifications.off.7': '1' } });
        const controller = r.make();
        await controller.start();

        await controller.enable();

        expect(controller.getState().offHere).toBe(false);
        expect(r.storage.data.has('pne.notifications.off.7')).toBe(false);
    });

    it('is refused in a browser that cannot do push and when the server has no key', async () => {
        const unsupported = rig({
            env: { support: { supported: false, reason: 'insecure' } },
        });
        expect(await unsupported.make().enable()).toBe('unsupported');
        expect(unsupported.env.requestPermission).not.toHaveBeenCalled();

        const noKey = rig({ vapid: null });
        expect(await noKey.make().enable()).toBe('unsupported');
        expect(noKey.env.requestPermission).not.toHaveBeenCalled();
    });

    it('shows it is busy while the browser is asking', async () => {
        const r = rig();
        let answer: (value: NotificationPermission) => void = () => undefined;
        r.env.requestPermission.mockImplementation(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        const controller = r.make();
        await controller.start();

        const pending = controller.enable();
        expect(controller.getState().busy).toBe('enable');

        answer('denied');
        await pending;
        expect(controller.getState().busy).toBeNull();
    });
});

describe('snooze and closing the dialog', () => {
    it('"Not now" hides the dialog and asks the server to snooze (the deadline is the server\'s)', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();
        await vi.advanceTimersByTimeAsync(1_500);

        await controller.snooze();

        expect(controller.getState().promptOpen).toBe(false);
        expect(r.api.updateSettings).toHaveBeenCalledWith({
            promptState: 'snoozed',
        });
        expect(controller.getState().settings?.snoozedUntil).toBe(
            '2026-11-27T09:00:00.000Z',
        );
        expect(r.env.requestPermission).not.toHaveBeenCalled();
    });

    it('closePrompt hides it without recording anything and cancels a pending open', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();

        controller.closePrompt();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(controller.getState().promptOpen).toBe(false);
        expect(r.api.updateSettings).not.toHaveBeenCalled();
    });
});

describe('disable and removing devices', () => {
    async function enabledRig() {
        const r = rig({ env: { permission: 'granted' } });
        const controller = r.make();

        await controller.start();

        return { r, controller };
    }

    it('turning off unsubscribes this browser, removes its row and remembers the choice', async () => {
        const { r, controller } = await enabledRig();
        const subscription = r.env.subscription!;

        await controller.disable();

        expect(subscription.unsubscribe).toHaveBeenCalled();
        expect(r.api.devicesState).toHaveLength(0);
        expect(controller.getState()).toMatchObject({
            subscribed: false,
            offHere: true,
            thisDeviceHash: null,
            busy: null,
        });
        expect(r.storage.data.get('pne.notifications.off.7')).toBe('1');
    });

    it('remembers it per user: another member signing in on this browser is not affected', async () => {
        const { r, controller } = await enabledRig();
        await controller.disable();

        const other = createNotificationsController({ ...r.deps, userId: 8 });
        expect(other.getState().offHere).toBe(false);
    });

    it('removing another browser leaves this one subscribed', async () => {
        const { r, controller } = await enabledRig();
        const other = deviceFixture({
            id: '01jother',
            endpointHash: 'someone-else',
        });
        r.api.devicesState = [other, ...r.api.devicesState];
        await controller.loadDevices();

        expect(await controller.removeDevice('01jother')).toBe(true);

        expect(r.api.devicesState.map((device) => device.id)).not.toContain(
            '01jother',
        );
        expect(controller.getState().subscribed).toBe(true);
        expect(r.env.subscription!.unsubscribe).not.toHaveBeenCalled();
    });

    it('removing this browser also unsubscribes it here and keeps it off', async () => {
        const { r, controller } = await enabledRig();
        const mine = controller
            .getState()
            .devices!.find(
                (device) =>
                    device.endpointHash ===
                    controller.getState().thisDeviceHash,
            )!;
        const subscription = r.env.subscription!;

        expect(await controller.removeDevice(mine.id)).toBe(true);

        expect(subscription.unsubscribe).toHaveBeenCalled();
        expect(controller.getState()).toMatchObject({
            subscribed: false,
            offHere: true,
        });
    });

    it('reports a removal the server refused and changes nothing here', async () => {
        const { r, controller } = await enabledRig();
        r.api.remove.mockRejectedValueOnce(
            new ApiError({
                status: 404,
                code: 'subscription_not_found',
                message: 'gone',
            }),
        );
        const id = controller.getState().devices![0].id;

        expect(await controller.removeDevice(id)).toBe(false);
        expect(controller.getState().subscribed).toBe(true);
    });
});

describe('sendTest', () => {
    it('reports how many devices got it', async () => {
        const r = rig({
            api: { devices: [deviceFixture(), deviceFixture({ id: '2' })] },
        });
        const controller = r.make();

        expect(await controller.sendTest()).toEqual({
            kind: 'sent',
            sent: 2,
            devices: 2,
        });
        expect(controller.getState().busy).toBeNull();
    });

    it('says "failed" when no push service accepted it', async () => {
        const r = rig();
        r.api.test.mockResolvedValue({
            devices: 1,
            sent: 0,
            failed: 1,
            removed: 0,
        });

        expect(await r.make().sendTest()).toEqual({ kind: 'failed' });
    });

    it.each([
        ['no_push_devices', 409, { kind: 'none' }],
        ['push_unavailable', 503, { kind: 'unavailable' }],
    ])('maps the server code %s', async (code, status, expected) => {
        const r = rig();
        r.api.test.mockRejectedValue(
            new ApiError({ status, code, message: 'x' }),
        );

        expect(await r.make().sendTest()).toEqual(expected);
    });

    it('maps the rate limit with its Retry-After', async () => {
        const r = rig();
        r.api.test.mockRejectedValue(
            new ApiError({
                status: 429,
                code: 'rate_limited',
                message: 'x',
                retryAfter: 30,
            }),
        );

        expect(await r.make().sendTest()).toEqual({
            kind: 'limited',
            retryAfter: 30,
        });
    });

    it('maps anything else (the network) to failed and reports it', async () => {
        const r = rig();
        r.api.test.mockRejectedValue(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );

        expect(await r.make().sendTest()).toEqual({ kind: 'failed' });
        expect(r.errors).toHaveLength(1);
    });
});

describe('updateSettings', () => {
    it('shows the change at once, saves it and keeps what the server answers', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();
        let release: () => void = () => undefined;
        r.api.updateSettings.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({ ...r.api.settingsState, pushOffers: false });
                }),
        );

        const saving = controller.updateSettings({ pushOffers: false });
        expect(controller.getState().settings?.pushOffers).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
        release();
        expect(await saving).toBe(true);
        expect(controller.getState().settings?.pushOffers).toBe(false);
    });

    it('puts the old values back when the server refuses', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();
        r.api.updateSettings.mockRejectedValueOnce(
            new ApiError({
                status: 422,
                code: 'validation_failed',
                message: 'no',
            }),
        );

        expect(
            await controller.updateSettings({
                sound: false,
                quietHours: { enabled: true },
            }),
        ).toBe(false);

        expect(controller.getState().settings?.sound).toBe(true);
        expect(controller.getState().settings?.quietHours.enabled).toBe(false);
        expect(r.errors).toHaveLength(1);
    });

    it('merges a partial quiet-hours change into the current window', async () => {
        const r = rig({
            api: {
                settings: {
                    quietHours: {
                        enabled: true,
                        start: '23:00',
                        end: '06:00',
                        timezone: 'Asia/Riyadh',
                    },
                },
            },
        });
        const controller = r.make();
        await controller.start();

        await controller.updateSettings({ quietHours: { end: '08:00' } });

        expect(controller.getState().settings?.quietHours).toEqual({
            enabled: true,
            start: '23:00',
            end: '08:00',
            timezone: 'Asia/Riyadh',
        });
    });

    it('runs saves one after the other, in the order they were made', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();
        const order: string[] = [];
        r.api.updateSettings.mockImplementation(async (patch) => {
            order.push(`start ${JSON.stringify(patch)}`);
            await Promise.resolve();
            order.push(`end ${JSON.stringify(patch)}`);

            return r.api.settingsState;
        });

        await Promise.all([
            controller.updateSettings({ sound: false }),
            controller.updateSettings({ pushOffers: false }),
        ]);

        expect(order).toEqual([
            'start {"sound":false}',
            'end {"sound":false}',
            'start {"pushOffers":false}',
            'end {"pushOffers":false}',
        ]);
    });

    it('lets the sound player follow a flipped sound switch, both ways, but not other changes', async () => {
        const r = rig();
        const controller = r.make();
        await controller.start();

        await controller.updateSettings({ sound: false });
        await controller.updateSettings({ sound: true });
        await controller.updateSettings({ pushOffers: false });

        expect(r.sound.toggle).toEqual([false, true]);
    });

    it('does nothing before the settings are loaded', async () => {
        const r = rig();

        expect(await r.make().updateSettings({ sound: false })).toBe(false);
        expect(r.api.updateSettings).not.toHaveBeenCalled();
    });
});

describe('messages from the service worker', () => {
    it('opens the chat a clicked notification points at', async () => {
        const r = rig();
        await r.make().start();

        r.env.emit({ type: 'pne:open', url: '/inbox/01jabc' });

        expect(r.opened).toEqual(['/inbox/01jabc']);
    });

    it.each([
        ['an absolute URL', 'https://evil.example/inbox'],
        ['a protocol-relative URL', '//evil.example/inbox'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a path with a backslash', '/\\evil.example'],
        ['a path with a space', '/inbox /x'],
        ['not a string', 42],
        ['nothing', undefined],
    ])('refuses to open %s', async (_label, url) => {
        const r = rig();
        await r.make().start();

        r.env.emit({ type: 'pne:open', url });

        expect(r.opened).toEqual([]);
    });

    it('ignores messages that are not its own', async () => {
        const r = rig();
        await r.make().start();

        r.env.emit('hello');
        r.env.emit(null);
        r.env.emit({ type: 'something-else', url: '/inbox' });

        expect(r.opened).toEqual([]);
    });

    it('checks the subscription again when the browser rotated it', async () => {
        const r = rig({ env: { permission: 'granted' } });
        await r.make().start();
        expect(r.api.register).toHaveBeenCalledTimes(1);

        r.env.emit({ type: 'pne:subscription-changed' });
        await vi.advanceTimersByTimeAsync(0);

        expect(r.api.register).toHaveBeenCalledTimes(2);
    });

    it('does not resubscribe a browser that is off or has no permission', async () => {
        const off = rig({
            env: { permission: 'granted' },
            storage: { 'pne.notifications.off.7': '1' },
        });
        await off.make().start();
        off.env.emit({ type: 'pne:subscription-changed' });

        const none = rig();
        await none.make().start();
        none.env.emit({ type: 'pne:subscription-changed' });
        await vi.advanceTimersByTimeAsync(0);

        expect(off.api.register).not.toHaveBeenCalled();
        expect(none.api.register).not.toHaveBeenCalled();
    });
});

describe('lifecycle', () => {
    it('stop removes the worker listener, cancels the dialog timer and silences later changes', async () => {
        const r = rig();
        const controller = r.make();
        const listener = vi.fn();
        controller.subscribe(listener);
        await controller.start();
        expect(r.env.workerListeners).toBe(1);
        listener.mockClear();

        controller.stop();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(r.env.workerListeners).toBe(0);
        expect(controller.getState().promptOpen).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    it('can start again after a stop (React strict mode starts, stops and starts the same controller)', async () => {
        const r = rig();
        const controller = r.make();

        const first = controller.start();
        controller.stop();
        const second = controller.start();
        await Promise.all([first, second]);
        await vi.advanceTimersByTimeAsync(1_500);

        expect(r.env.workerListeners).toBe(1);
        expect(controller.getState().settingsStatus).toBe('ready');
        // The first run, interrupted by the stop, did not open a second dialog or listener.
        expect(controller.getState().promptOpen).toBe(true);

        controller.stop();
        expect(r.env.workerListeners).toBe(0);
    });

    it('notifies subscribers of changes and lets them unsubscribe', async () => {
        const r = rig();
        const controller = r.make();
        const listener = vi.fn();
        const unsubscribe = controller.subscribe(listener);

        await controller.start();
        expect(listener).toHaveBeenCalled();

        listener.mockClear();
        unsubscribe();
        await controller.updateSettings({ sound: false });
        expect(listener).not.toHaveBeenCalled();
    });

    it('survives a storage that throws (private mode)', async () => {
        const broken = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
            removeItem: () => {
                throw new Error('denied');
            },
        };
        const r = rig({
            env: { permission: 'granted' },
            deps: { storage: broken },
        });
        const controller = r.make();

        await controller.start();
        await controller.disable();

        expect(controller.getState().offHere).toBe(true);
    });
});

describe('openablePath', () => {
    it('accepts only same-origin absolute paths', () => {
        expect(openablePath('/inbox')).toBe('/inbox');
        expect(openablePath('/inbox/01jabc?x=1#y')).toBe('/inbox/01jabc?x=1#y');
        expect(openablePath('//evil.example')).toBeNull();
        expect(openablePath('inbox')).toBeNull();
        expect(openablePath('')).toBeNull();
    });
});

describe("osPreferencesOf (what the page's own OS notifications may show)", () => {
    it('allows visitor text only when the administrator AND the member allow it', () => {
        const previews = (
            previewsAllowed: boolean,
            includePreview: boolean,
        ): boolean =>
            osPreferencesOf({
                settings: settingsFixture({ previewsAllowed, includePreview }),
                offHere: false,
            }).previews;

        expect(previews(true, true)).toBe(true);
        expect(previews(false, true)).toBe(false);
        expect(previews(true, false)).toBe(false);
        expect(previews(false, false)).toBe(false);
    });

    it("carries the two push switches and this browser's off choice", () => {
        expect(
            osPreferencesOf({
                settings: settingsFixture({
                    pushOffers: false,
                    pushMessages: true,
                }),
                offHere: true,
            }),
        ).toEqual({
            previews: true,
            offers: false,
            messages: true,
            off: true,
        });
    });

    it('says no visitor text, and the server defaults for the switches, until the settings have loaded', () => {
        expect(osPreferencesOf({ settings: null, offHere: false })).toEqual({
            previews: false,
            offers: true,
            messages: true,
            off: false,
        });
    });
});
