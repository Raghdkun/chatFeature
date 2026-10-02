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
    resetOsNotificationPolicy,
    setOsNotificationPolicy,
    showOsNotification,
    type OsNotificationEnv,
    type OsNotificationOptions,
    type OsPreferences,
} from '@/lib/realtime/staff/os-notification';

/** P5-D8: the page's own notification agrees with the server's push (same tag), stays quiet when it should, and works where `new Notification()` does not. */
class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static instances: FakeNotification[] = [];
    onclick: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    closed = false;
    closeCalls = 0;

    constructor(
        public title: string,
        public options?: { body?: string; tag?: string },
    ) {
        FakeNotification.instances.push(this);
    }

    close() {
        this.closed = true;
        this.closeCalls++;
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
    resetOsNotificationPolicy();
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

    it('shows a message notification under the push tag so the browser replaces, never doubles', async () => {
        await showOsNotification(
            { title: 'New message', tag: `message-${ULID}` },
            env(),
        );

        expect(FakeNotification.instances[0].options?.tag).toBe(`chat-${ULID}`);

        // The server's push for the same chat has the same tag: a later page notification replaces it.
        await showOsNotification(
            { title: 'New message again', tag: `chat-${ULID}` },
            env(),
        );
        expect(FakeNotification.instances[0].closed).toBe(true);
    });
});

describe('when the page may show one', () => {
    it('only in the background (focused = toast and sound only)', async () => {
        expect(
            await showOsNotification(
                { title: 'x', tag: `offer-${ULID}` },
                env({ pageInFront: () => true }),
            ),
        ).toBe(false);
        expect(FakeNotification.instances).toHaveLength(0);
    });

    it('never without a permission already granted, and never asks', async () => {
        const request = vi.fn();
        (
            FakeNotification as unknown as { requestPermission: () => void }
        ).requestPermission = request;

        for (const permission of ['default', 'denied'] as const) {
            FakeNotification.permission = permission;
            expect(
                await showOsNotification({ title: 'x', tag: 't' }, env()),
            ).toBe(false);
        }

        expect(request).not.toHaveBeenCalled();
    });

    it("not during the member's quiet hours", async () => {
        expect(
            await showOsNotification(
                { title: 'x', tag: 'q1' },
                env({ quiet: () => true }),
            ),
        ).toBe(false);
    });

    it('takes the quiet hours the notifications controller registered (the page-wide default)', async () => {
        vi.stubGlobal('Notification', FakeNotification);
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        try {
            setOsNotificationPolicy({ quiet: () => true });
            expect(await showOsNotification({ title: 'x', tag: 'q2' })).toBe(
                false,
            );

            setOsNotificationPolicy({ quiet: () => false });
            expect(await showOsNotification({ title: 'x', tag: 'q3' })).toBe(
                true,
            );
        } finally {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
    });
});

/** The member's own switches (F1): the page's notifications obey them exactly like the server's push does. */
describe("the member's preferences", () => {
    const preferences = (
        overrides: Partial<OsPreferences> = {},
    ): OsPreferences => ({
        previews: true,
        offers: true,
        messages: true,
        off: false,
        ...overrides,
    });

    const offer: OsNotificationOptions = {
        title: 'New chat request',
        body: 'Maya Thompson, Billing',
        tag: `offer-${ULID}`,
        kind: 'offer',
        generic: { title: 'New chat request', body: 'Billing' },
    };
    const message: OsNotificationOptions = {
        title: 'New message from Maya Thompson',
        body: 'Where is my invoice?',
        tag: `message-${ULID}`,
        kind: 'message',
        generic: { title: 'New message', body: 'Open the chat to read it.' },
    };

    it('shows the visitor name and words only when previews are allowed', async () => {
        await showOsNotification(
            offer,
            env({ preferences: () => preferences() }),
        );
        await showOsNotification(
            message,
            env({ preferences: () => preferences() }),
        );

        expect(
            FakeNotification.instances.map((n) => [n.title, n.options?.body]),
        ).toEqual([
            ['New chat request', 'Maya Thompson, Billing'],
            ['New message from Maya Thompson', 'Where is my invoice?'],
        ]);
    });

    it('uses the generic wording when the administrator (or the member) turned previews off: no visitor name, no words', async () => {
        const privateEnv = env({
            preferences: () => preferences({ previews: false }),
        });

        await showOsNotification(offer, privateEnv);
        await showOsNotification(message, privateEnv);

        const shown = FakeNotification.instances.map((n) => [
            n.title,
            n.options?.body,
        ]);

        expect(shown).toEqual([
            ['New chat request', 'Billing'],
            ['New message', 'Open the chat to read it.'],
        ]);
        expect(JSON.stringify(shown)).not.toMatch(/Maya|invoice/);
    });

    it('a private notification without generic wording only keeps its title (and never the body)', async () => {
        await showOsNotification(
            { title: 'Title only', body: 'Secret words', tag: 'x-1' },
            env({ preferences: () => preferences({ previews: false }) }),
        );

        expect(FakeNotification.instances[0].title).toBe('Title only');
        expect(FakeNotification.instances[0].options?.body).toBeUndefined();
    });

    it('shows nothing after "Turn off for this browser", for offers and messages alike', async () => {
        const off = env({ preferences: () => preferences({ off: true }) });

        expect(await showOsNotification(offer, off)).toBe(false);
        expect(await showOsNotification(message, off)).toBe(false);
        expect(FakeNotification.instances).toHaveLength(0);
    });

    it('"New chat requests" off stops the offers only', async () => {
        const noOffers = env({
            preferences: () => preferences({ offers: false }),
        });

        expect(await showOsNotification(offer, noOffers)).toBe(false);
        expect(await showOsNotification(message, noOffers)).toBe(true);
        expect(FakeNotification.instances).toHaveLength(1);
    });

    it('"New messages" off stops the messages only', async () => {
        const noMessages = env({
            preferences: () => preferences({ messages: false }),
        });

        expect(await showOsNotification(message, noMessages)).toBe(false);
        expect(await showOsNotification(offer, noMessages)).toBe(true);
        expect(FakeNotification.instances).toHaveLength(1);
    });

    it('reads the kind from the tag when the caller did not say', async () => {
        const noOffers = env({
            preferences: () => preferences({ offers: false }),
        });

        expect(
            await showOsNotification(
                { title: 'x', tag: `offer-${ULID}` },
                noOffers,
            ),
        ).toBe(false);
        expect(
            await showOsNotification(
                { title: 'x', tag: `chat-${ULID}` },
                noOffers,
            ),
        ).toBe(true);
    });

    it('every combination of the switches decides independently (the full matrix)', async () => {
        for (const previews of [true, false]) {
            for (const offers of [true, false]) {
                for (const messages of [true, false]) {
                    for (const off of [true, false]) {
                        FakeNotification.instances = [];

                        const mine = env({
                            preferences: () => ({
                                previews,
                                offers,
                                messages,
                                off,
                            }),
                        });
                        const offerShown = await showOsNotification(
                            { ...offer, tag: `offer-${ULID}` },
                            mine,
                        );
                        const messageShown = await showOsNotification(
                            { ...message, tag: `message-${ULID}` },
                            mine,
                        );

                        expect(offerShown).toBe(offers && !off);
                        expect(messageShown).toBe(messages && !off);
                        expect(FakeNotification.instances).toHaveLength(
                            Number(offerShown) + Number(messageShown),
                        );

                        for (const shown of FakeNotification.instances) {
                            const text = `${shown.title} ${shown.options?.body ?? ''}`;

                            expect(/Maya|invoice/.test(text)).toBe(previews);
                        }
                    }
                }
            }
        }
    });

    it('the page-wide default (the controller has not registered anything yet) is: no visitor text, switches as the server defaults them', async () => {
        vi.stubGlobal('Notification', FakeNotification);
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);

        try {
            expect(await showOsNotification(offer)).toBe(true);
            expect(FakeNotification.instances[0].options?.body).toBe('Billing');

            setOsNotificationPolicy({
                preferences: () => preferences({ previews: true }),
            });
            await showOsNotification(message);

            expect(FakeNotification.instances[1].title).toBe(
                'New message from Maya Thompson',
            );

            setOsNotificationPolicy({
                preferences: () => preferences({ off: true }),
            });
            expect(await showOsNotification(offer)).toBe(false);
        } finally {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        }
    });
});

describe('where it is shown from', () => {
    it('goes through the service worker whenever one is active, never through new Notification (the push shares its list and tag)', async () => {
        const worker = registrationDouble();

        const shown = await showOsNotification(
            {
                title: 'New chat request',
                body: 'Billing',
                tag: `offer-${ULID}`,
            },
            env({ registration: async () => worker.registration }),
        );

        expect(shown).toBe(true);
        expect(FakeNotification.instances).toHaveLength(0);
        expect(worker.shown).toHaveLength(1);
        expect(worker.shown[0].title).toBe('New chat request');
        expect(worker.shown[0].options).toMatchObject({
            body: 'Billing',
            tag: `offer-${ULID}`,
            renotify: false,
            requireInteraction: true,
            data: {
                url: `/inbox/${ULID}`,
                tag: `offer-${ULID}`,
                type: 'offer',
            },
        });
    });

    it("a chat's message re-alerts like the server's push (renotify) and does not require interaction", async () => {
        const worker = registrationDouble();

        await showOsNotification(
            { title: 'New message', tag: `message-${ULID}` },
            env({ registration: async () => worker.registration }),
        );

        expect(worker.shown[0].options).toMatchObject({
            tag: `chat-${ULID}`,
            renotify: true,
            requireInteraction: false,
            data: { url: `/inbox/${ULID}`, type: 'message' },
        });
    });

    it('honours the preferences on the worker path too (generic wording, nothing when off)', async () => {
        const worker = registrationDouble();
        const base = {
            registration: async () => worker.registration,
        };

        expect(
            await showOsNotification(
                {
                    title: 'New message from Maya',
                    body: 'secret',
                    tag: `message-${ULID}`,
                    generic: { title: 'New message', body: 'Open it.' },
                },
                env({
                    ...base,
                    preferences: () => ({
                        previews: false,
                        offers: true,
                        messages: true,
                        off: false,
                    }),
                }),
            ),
        ).toBe(true);
        expect(worker.shown[0]).toMatchObject({
            title: 'New message',
            options: { body: 'Open it.' },
        });

        expect(
            await showOsNotification(
                { title: 'x', tag: `message-${ULID}` },
                env({
                    ...base,
                    preferences: () => ({
                        previews: true,
                        offers: true,
                        messages: true,
                        off: true,
                    }),
                }),
            ),
        ).toBe(false);
        expect(worker.shown).toHaveLength(1);
    });

    it('closes a notification of the page that still lingers under the tag before the worker shows the new one', async () => {
        const worker = registrationDouble();

        await showOsNotification({ title: 'a', tag: `offer-${ULID}` }, env());
        await showOsNotification(
            { title: 'b', tag: `offer-${ULID}` },
            env({ registration: async () => worker.registration }),
        );

        expect(FakeNotification.instances[0].closed).toBe(true);
        expect(worker.shown).toHaveLength(1);
    });

    it('falls back to new Notification when there is no worker', async () => {
        expect(
            await showOsNotification(
                { title: 'x', tag: 't' },
                env({ registration: async () => null }),
            ),
        ).toBe(true);
        expect(FakeNotification.instances).toHaveLength(1);
    });

    it('falls back to new Notification when asking for the worker fails or the worker refuses', async () => {
        const refusing = {
            showNotification: vi.fn(async () => {
                throw new Error('nope');
            }),
            getNotifications: vi.fn(async () => []),
        };

        expect(
            await showOsNotification(
                { title: 'x', tag: 'a' },
                env({
                    registration: async () => {
                        throw new Error('no registration');
                    },
                }),
            ),
        ).toBe(true);
        expect(
            await showOsNotification(
                { title: 'y', tag: 'b' },
                env({ registration: async () => refusing }),
            ),
        ).toBe(true);
        expect(refusing.showNotification).toHaveBeenCalled();
        expect(FakeNotification.instances.map((n) => n.title)).toEqual([
            'x',
            'y',
        ]);
    });
});

describe('where new Notification() is not allowed (Android) and no worker is active', () => {
    class Throwing {
        static permission: NotificationPermission = 'granted';
        constructor() {
            throw new TypeError('Illegal constructor');
        }
    }

    it('reports nothing shown (the toast and sound already announced it)', async () => {
        expect(
            await showOsNotification(
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

        expect(
            await showOsNotification(
                { title: 'x', tag: 't' },
                env({
                    Notification:
                        Throwing as unknown as OsNotificationEnv['Notification'],
                    registration: async () => failing,
                }),
            ),
        ).toBe(false);
        expect(failing.showNotification).toHaveBeenCalled();
    });
});

describe('the page notifications it keeps track of', () => {
    it('focuses the window, runs the click handler and forgets the notification (no stale close later)', async () => {
        const focusWindow = vi.fn();
        const onClick = vi.fn();

        await showOsNotification(
            { title: 'x', tag: `offer-${ULID}`, onClick },
            env({ focusWindow }),
        );
        const shown = FakeNotification.instances[0];

        shown.onclick?.(new Event('click'));

        expect(focusWindow).toHaveBeenCalled();
        expect(onClick).toHaveBeenCalled();
        expect(shown.closeCalls).toBe(1);

        // Clicked and gone: a later dismissal of the same offer has nothing of the page's to close.
        closeOsNotification(`offer-${ULID}`, {
            registration: async () => null,
        });
        expect(shown.closeCalls).toBe(1);
    });

    it('forgets a notification the person closed', async () => {
        await showOsNotification({ title: 'x', tag: `offer-${ULID}` }, env());
        const shown = FakeNotification.instances[0];

        shown.onclose?.(new Event('close'));
        closeOsNotification(`offer-${ULID}`, {
            registration: async () => null,
        });
        await showOsNotification({ title: 'y', tag: `offer-${ULID}` }, env());

        expect(shown.closeCalls).toBe(0);
    });

    it('a closed older notification does not make the registry forget the newer one with the same tag', async () => {
        await showOsNotification({ title: 'a', tag: 'same-1' }, env());
        await showOsNotification({ title: 'b', tag: 'same-1' }, env());

        // The first one was closed by the replacement: its late `close` event must not drop the second.
        FakeNotification.instances[0].onclose?.(new Event('close'));
        closeOsNotification('same-1', { registration: async () => null });

        expect(FakeNotification.instances[1].closed).toBe(true);
    });
});

describe('closeOsNotification', () => {
    it("closes the page's notification under its push tag (also for the inbox's message tag)", async () => {
        await showOsNotification({ title: 'x', tag: `message-${ULID}` }, env());

        closeOsNotification(`message-${ULID}`, {
            registration: async () => null,
        });

        expect(FakeNotification.instances[0].closed).toBe(true);
    });

    it('also closes what the service worker (a push, or a notification of the page) is showing under the tag', async () => {
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
