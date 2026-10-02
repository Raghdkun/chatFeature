import '@/tests/dom-polyfills';
import { act, StrictMode } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    NotificationsHost,
    pushKeyOf,
} from '@/components/notifications/notifications-host';
import {
    useNotificationsOptional,
    useNotificationsState,
} from '@/lib/notifications/context';
import {
    StaffRealtimeContext,
    type StaffRealtimeContextValue,
} from '@/lib/realtime/staff/context';
import { setOsNotificationPolicy } from '@/lib/realtime/staff/os-notification';
import {
    fireRouterEvent,
    resetInertiaMock,
    routerMock,
} from '@/tests/inertia-mock';
import {
    fakeEnv,
    fakeNotificationsApi,
    fakeStorage,
    VAPID_KEY,
    type FakeEnv,
    type FakeNotificationsApi,
} from '@/tests/notifications-kit';
import { render } from '@/tests/render';
import { fakeSound, type FakeSound } from '@/tests/staff-kit';

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
vi.mock('@/lib/realtime/staff/os-notification', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('@/lib/realtime/staff/os-notification')
    >()),
    setOsNotificationPolicy: vi.fn(),
}));

const staff = { id: 7, name: 'Sam', is_admin: false, is_agent: true };
const page = (
    user: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
    url = '/dashboard',
) => ({
    props: {
        auth: { user },
        locale: 'en',
        push: { vapidPublicKey: VAPID_KEY },
        ...extra,
    },
    url,
});

function Probe() {
    const controller = useNotificationsOptional();
    const state = useNotificationsState(controller);

    return (
        <p
            data-testid="probe"
            data-controller={controller ? 'yes' : 'no'}
            data-settings={state?.settingsStatus ?? 'none'}
            data-push={state?.pushConfigured ? 'on' : 'off'}
        />
    );
}

function setup(): {
    env: FakeEnv;
    api: FakeNotificationsApi;
    sound: FakeSound;
    deps: NonNullable<Parameters<typeof NotificationsHost>[0]['deps']>;
    wrap: (children: React.ReactNode) => React.ReactElement;
} {
    const env = fakeEnv();
    const api = fakeNotificationsApi();
    const sound = fakeSound();
    const deps = { api, env, storage: fakeStorage(), promptDelayMs: 0 };
    const context = { sound } as unknown as StaffRealtimeContextValue;

    return {
        env,
        api,
        sound,
        deps,
        wrap: (children) => (
            <StaffRealtimeContext.Provider value={context}>
                {children}
            </StaffRealtimeContext.Provider>
        ),
    };
}

beforeEach(() => {
    resetInertiaMock();
    vi.clearAllMocks();
});

afterEach(() => vi.clearAllMocks());

describe('who gets a notification session', () => {
    it('gives none to a guest or to an account without a chat role', async () => {
        const r = setup();

        for (const user of [
            null,
            { id: 3, name: 'Nobody', is_admin: false, is_agent: false },
        ]) {
            const view = await render(
                r.wrap(
                    <NotificationsHost initialPage={page(user)} deps={r.deps}>
                        <Probe />
                    </NotificationsHost>,
                ),
            );

            expect(
                view.byTestId('probe')?.getAttribute('data-controller'),
            ).toBe('no');
            await view.unmount();
        }

        expect(r.api.settings).not.toHaveBeenCalled();
    });

    it('starts one for a member of staff: loads their settings, nothing is asked of the browser', async () => {
        const r = setup();

        const view = await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        expect(view.byTestId('probe')?.getAttribute('data-controller')).toBe(
            'yes',
        );
        expect(view.byTestId('probe')?.getAttribute('data-settings')).toBe(
            'ready',
        );
        expect(view.byTestId('probe')?.getAttribute('data-push')).toBe('on');
        expect(r.api.settings).toHaveBeenCalledTimes(1);
        expect(r.env.requestPermission).not.toHaveBeenCalled();
    });

    it('knows push is off when the server shares no key', async () => {
        const r = setup();

        const view = await render(
            r.wrap(
                <NotificationsHost
                    initialPage={page(staff, { push: null })}
                    deps={r.deps}
                >
                    <Probe />
                </NotificationsHost>,
            ),
        );

        expect(view.byTestId('probe')?.getAttribute('data-push')).toBe('off');
    });

    it('starts a new session when somebody else signs in, and stops the old one', async () => {
        const r = setup();

        const view = await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        expect(r.env.workerListeners).toBe(1);

        await act(async () => {
            fireRouterEvent('navigate', {
                page: page({
                    id: 8,
                    name: 'Lee',
                    is_admin: false,
                    is_agent: true,
                }),
            });
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        expect(r.api.settings).toHaveBeenCalledTimes(2);
        expect(r.env.workerListeners).toBe(1);

        await view.unmount();
        expect(r.env.workerListeners).toBe(0);
    });

    it('keeps the session across navigations of the same user', async () => {
        const r = setup();

        await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        await act(async () => {
            fireRouterEvent('navigate', { page: page(staff, {}, '/inbox') });
            fireRouterEvent('navigate', { page: page(staff, {}, '/history') });
        });

        expect(r.api.settings).toHaveBeenCalledTimes(1);
    });
});

describe('React strict mode', () => {
    it('keeps a working session when the effects run twice (the dev double mount)', async () => {
        const r = setup();

        const view = await render(
            <StrictMode>
                {r.wrap(
                    <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                        <Probe />
                    </NotificationsHost>,
                )}
            </StrictMode>,
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });

        expect(view.byTestId('probe')?.getAttribute('data-settings')).toBe(
            'ready',
        );
        expect(r.env.workerListeners).toBe(1);
        // The dialog opens once (after the delay), not twice.
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });
});

describe('sound', () => {
    it('mutes the player when the server says sound is off, but never unmutes one the person muted', async () => {
        const r = setup();
        r.api.settingsState = { ...r.api.settingsState, sound: false };

        await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        expect(r.sound.isMuted()).toBe(true);

        // A device muted locally stays muted when the server says sound is on.
        const second = setup();
        second.sound.setMuted(true);
        await render(
            second.wrap(
                <NotificationsHost initialPage={page(staff)} deps={second.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        expect(second.sound.isMuted()).toBe(true);
    });

    it('does not mute anything when the server says sound is on', async () => {
        const r = setup();

        await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        expect(r.sound.isMuted()).toBe(false);
    });
});

describe('the dialog and the page', () => {
    it('opens the first-login dialog on a dashboard page, but not on the notification settings page', async () => {
        const r = setup();

        await render(
            r.wrap(
                <NotificationsHost
                    initialPage={page(staff, {}, '/settings/notifications')}
                    deps={r.deps}
                >
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        await act(async () => {
            fireRouterEvent('navigate', {
                page: page(staff, {}, '/dashboard'),
            });
        });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('opens the chat a clicked notification asks for, through the router, only for same-origin paths', async () => {
        const r = setup();

        await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        r.env.emit({ type: 'pne:open', url: '/inbox/01jchat' });
        r.env.emit({ type: 'pne:open', url: 'https://evil.example/' });

        expect(routerMock.visit).toHaveBeenCalledTimes(1);
        expect(routerMock.visit).toHaveBeenCalledWith('/inbox/01jchat');
    });

    it('hands the path to onOpen when given one', async () => {
        const r = setup();
        const onOpen = vi.fn();

        await render(
            r.wrap(
                <NotificationsHost
                    initialPage={page(staff)}
                    deps={r.deps}
                    onOpen={onOpen}
                >
                    <Probe />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        r.env.emit({ type: 'pne:open', url: '/inbox' });

        expect(onOpen).toHaveBeenCalledWith('/inbox');
        expect(routerMock.visit).not.toHaveBeenCalled();
    });
});

describe("quiet hours for the page's own notifications", () => {
    it('registers a policy that follows the saved window, and removes it on unmount', async () => {
        const r = setup();
        r.api.settingsState = {
            ...r.api.settingsState,
            quietHours: {
                enabled: true,
                start: '00:00',
                end: '23:59',
                timezone: 'UTC',
            },
        };
        let controller: ReturnType<typeof useNotificationsOptional> = null;

        function Grab() {
            controller = useNotificationsOptional();

            return null;
        }

        const view = await render(
            r.wrap(
                <NotificationsHost initialPage={page(staff)} deps={r.deps}>
                    <Grab />
                </NotificationsHost>,
            ),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });

        const registered = vi
            .mocked(setOsNotificationPolicy)
            .mock.calls.at(-1)?.[0];
        expect(registered?.quiet?.()).toBe(true);

        // The policy reads the live settings: switching the window off makes the page's notifications audible again.
        await act(async () => {
            await controller?.updateSettings({
                quietHours: { enabled: false },
            });
        });
        expect(registered?.quiet?.()).toBe(false);

        await view.unmount();
        expect(
            vi.mocked(setOsNotificationPolicy).mock.calls.at(-1)?.[0],
        ).toEqual({ quiet: null });
    });
});

describe('pushKeyOf', () => {
    it('reads the key the server shares, and nothing else', () => {
        expect(pushKeyOf(page(staff))).toBe(VAPID_KEY);
        expect(pushKeyOf(page(staff, { push: null }))).toBeNull();
        expect(pushKeyOf(page(staff, { push: {} }))).toBeNull();
        expect(
            pushKeyOf(page(staff, { push: { vapidPublicKey: '' } })),
        ).toBeNull();
        expect(pushKeyOf({ props: {} })).toBeNull();
    });
});
