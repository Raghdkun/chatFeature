import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vite-plus/test';
import {
    closeOsNotification,
    notificationPath,
    notificationTag,
    setOsNotificationPolicy,
    showOsNotification,
    type OsNotificationEnv,
} from '@/lib/realtime/staff/os-notification';

/** P5-D8: the page's own notification agrees with the server's push (same tag), stays quiet when it should, and works where `new Notification()` does not. */
class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static instances: FakeNotification[] = [];
    onclick: ((event: Event) => void) | null = null;
    closed = false;

    constructor(
        public title: string,
        public options?: { body?: string; tag?: string },
    ) {
        FakeNotification.instances.push(this);
    }

    close() {
        this.closed = true;
    }
}

const ULID = '01m3x37q3hw0n06t7am5tpzrm7';

function registrationDouble() {
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const open: { tag: string; close: Mock<() => void> }[] = [];
    const registration = {
        showNotification: vi.fn(
            async (title: string, options?: Record<string, unknown>) => {
                shown.push({ title, options: options ?? {} });
            },
        ),
        getNotifications: vi.fn(async (filter?: { tag?: string }) =>
            open.filter((n) => n.tag === filter?.tag),
        ),
    };

    return { registration, shown, open };
}

const env = (
    overrides: Partial<OsNotificationEnv> = {},
): OsNotificationEnv => ({
    Notification: FakeNotification,
    pageInFront: () => false,
    focusWindow: vi.fn(),
    ...overrides,
});

beforeEach(() => {
    FakeNotification.permission = 'granted';
    FakeNotification.instances = [];
    setOsNotificationPolicy({ quiet: null });
});

describe('tags', () => {
    it("maps the inbox's message tag to the server push tag of the same chat", () => {
        expect(notificationTag(`message-${ULID}`)).toBe(`chat-${ULID}`);
        expect(notificationTag(`offer-${ULID}`)).toBe(`offer-${ULID}`);
        expect(notificationTag(`chat-${ULID}`)).toBe(`chat-${ULID}`);
        expect(notificationTag('other')).toBe('other');
    });

    it('knows which chat a tag stands for', () => {
        expect(notificationPath(`offer-${ULID}`)).toBe(`/inbox/${ULID}`);
        expect(notificationPath(`message-${ULID}`)).toBe(`/inbox/${ULID}`);
        expect(notificationPath(`chat-${ULID}`)).toBe(`/inbox/${ULID}`);
        expect(notificationPath('test-7')).toBe('/inbox');
        expect(notificationPath('offer-short')).toBe('/inbox');
    });

    it('shows a message notification under the push tag so the browser replaces, never doubles', () => {
        showOsNotification(
            { title: 'New message', tag: `message-${ULID}` },
            env(),
        );

        expect(FakeNotification.instances[0].options?.tag).toBe(`chat-${ULID}`);

        // The server's push for the same chat has the same tag: a later page notification replaces it.
        showOsNotification(
            { title: 'New message again', tag: `chat-${ULID}` },
            env(),
        );
        expect(FakeNotification.instances[0].closed).toBe(true);
    });
});

describe('when the page may show one', () => {
    it('only in the background (focused = toast and sound only)', () => {
        expect(
            showOsNotification(
                { title: 'x', tag: `offer-${ULID}` },
                env({ pageInFront: () => true }),
            ),
        ).toBe(false);
        expect(FakeNotification.instances).toHaveLength(0);
    });

    it('never without a permission already granted, and never asks', () => {
        const request = vi.fn();
        (
            FakeNotification as unknown as { requestPermission: () => void }
        ).requestPermission = request;

        for (const permission of ['default', 'denied'] as const) {
            FakeNotification.permission = permission;
            expect(showOsNotification({ title: 'x', tag: 't' }, env())).toBe(
                false,
            );
        }

        expect(request).not.toHaveBeenCalled();
    });

    it("not during the member's quiet hours", () => {
        expect(
            showOsNotification(
                { title: 'x', tag: 'q1' },
                env({ quiet: () => true }),
            ),
        ).toBe(false);
    });

    it('takes the quiet hours the notifications controller registered (the page-wide default)', () => {
        vi.stubGlobal('Notification', FakeNotification);
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        try {
            setOsNotificationPolicy({ quiet: () => true });
            expect(showOsNotification({ title: 'x', tag: 'q2' })).toBe(false);

            setOsNotificationPolicy({ quiet: () => false });
            expect(showOsNotification({ title: 'x', tag: 'q3' })).toBe(true);
        } finally {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
    });
});

describe('where new Notification() is not allowed (Android)', () => {
    class Throwing {
        static permission: NotificationPermission = 'granted';
        constructor() {
            throw new TypeError('Illegal constructor');
        }
    }

    it('shows it through the service worker with the dashboard path for its click', async () => {
        const worker = registrationDouble();

        const shown = showOsNotification(
            {
                title: 'New chat request',
                body: 'Billing',
                tag: `offer-${ULID}`,
            },
            env({
                Notification:
                    Throwing as unknown as OsNotificationEnv['Notification'],
                registration: async () => worker.registration,
            }),
        );
        await vi.waitFor(() => expect(worker.shown).toHaveLength(1));

        expect(shown).toBe(true);
        expect(worker.shown[0].title).toBe('New chat request');
        expect(worker.shown[0].options).toMatchObject({
            body: 'Billing',
            tag: `offer-${ULID}`,
            data: { url: `/inbox/${ULID}`, tag: `offer-${ULID}` },
        });
    });

    it('reports nothing shown when there is no worker to ask', () => {
        expect(
            showOsNotification(
                { title: 'x', tag: 't' },
                {
                    Notification:
                        Throwing as unknown as OsNotificationEnv['Notification'],
                    pageInFront: () => false,
                    focusWindow: () => undefined,
                },
            ),
        ).toBe(false);
    });

    it('swallows a worker that fails too', async () => {
        const failing = {
            showNotification: vi.fn(async () => {
                throw new Error('nope');
            }),
            getNotifications: vi.fn(async () => []),
        };

        showOsNotification(
            { title: 'x', tag: 't' },
            env({
                Notification:
                    Throwing as unknown as OsNotificationEnv['Notification'],
                registration: async () => failing,
            }),
        );
        await vi.waitFor(() =>
            expect(failing.showNotification).toHaveBeenCalled(),
        );
    });
});

describe('closeOsNotification', () => {
    it("closes the page's notification under its push tag (also for the inbox's message tag)", () => {
        showOsNotification({ title: 'x', tag: `message-${ULID}` }, env());

        closeOsNotification(`message-${ULID}`, {
            registration: async () => null,
        });

        expect(FakeNotification.instances[0].closed).toBe(true);
    });

    it('also closes what the service worker (a push, or the Android fallback) is showing under the tag', async () => {
        const worker = registrationDouble();
        const close = vi.fn();
        worker.open.push({ tag: `offer-${ULID}`, close });

        closeOsNotification(`offer-${ULID}`, {
            registration: async () => worker.registration,
        });

        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
        expect(worker.registration.getNotifications).toHaveBeenCalledWith({
            tag: `offer-${ULID}`,
        });
    });
});
