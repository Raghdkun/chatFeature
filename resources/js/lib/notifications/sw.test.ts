/**
 * `public/sw.js` loaded into a fake ServiceWorkerGlobalScope: the real file, run in a `vm` context with a scriptable
 * `registration`, `clients` and `fetch`, so its three handlers are tested without a browser.
 */
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const files = import.meta.glob<string>('/public/sw.js', {
    eager: true,
    query: '?raw',
    import: 'default',
});
const SOURCE = Object.values(files)[0];
const ORIGIN = 'https://chat.example.test';

type Shown = {
    title: string;
    options: Record<string, unknown>;
    closed: boolean;
};
type FakeClient = {
    url: string;
    focused?: boolean;
    visibilityState?: string;
    focus: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
};
type WorkerEvent = Record<string, unknown> & {
    waitUntil: (promise: Promise<unknown>) => void;
};

function client(url: string, overrides: Partial<FakeClient> = {}): FakeClient {
    const self: FakeClient = {
        url,
        focused: false,
        visibilityState: 'hidden',
        focus: vi.fn(async () => self),
        postMessage: vi.fn(),
        ...overrides,
    };

    return self;
}

function loadWorker(
    options: { clients?: FakeClient[]; cookies?: Record<string, string> } = {},
) {
    const handlers = new Map<string, (event: WorkerEvent) => void>();
    const notifications: Shown[] = [];
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    const clients = {
        claim: vi.fn(async () => undefined),
        matchAll: vi.fn(async () => options.clients ?? []),
        openWindow: vi.fn(async () => null),
    };
    const subscribe = vi.fn(async () => ({
        toJSON: () => ({
            endpoint: 'https://fcm.googleapis.com/fcm/send/fresh',
            keys: { p256dh: 'p', auth: 'a' },
        }),
    }));
    const scope: Record<string, unknown> = {
        location: new URL(`${ORIGIN}/sw.js`),
        addEventListener: (
            type: string,
            handler: (event: WorkerEvent) => void,
        ) => handlers.set(type, handler),
        skipWaiting: vi.fn(),
        clients,
        registration: {
            showNotification: vi.fn(
                async (title: string, opts: Record<string, unknown>) => {
                    // Same tag replaces, like the browser.
                    const index = notifications.findIndex(
                        (n) =>
                            opts.tag !== undefined &&
                            n.options.tag === opts.tag &&
                            !n.closed,
                    );

                    if (index >= 0) {
                        notifications[index].closed = true;
                    }

                    notifications.push({ title, options: opts, closed: false });
                },
            ),
            getNotifications: vi.fn(async (filter?: { tag?: string }) =>
                notifications
                    .filter(
                        (n) =>
                            !n.closed &&
                            (filter?.tag === undefined ||
                                n.options.tag === filter.tag),
                    )
                    .map((n) => ({
                        close: () => {
                            n.closed = true;
                        },
                        tag: n.options.tag,
                    })),
            ),
            pushManager: { subscribe },
        },
        cookieStore: options.cookies
            ? {
                  get: vi.fn(async (name: string) =>
                      options.cookies![name]
                          ? { value: options.cookies![name] }
                          : null,
                  ),
              }
            : undefined,
    };

    scope.self = scope;
    runInNewContext(SOURCE, { self: scope, URL, fetch: fetchMock, console });

    async function fire(
        type: string,
        event: Record<string, unknown> = {},
    ): Promise<void> {
        const waited: Promise<unknown>[] = [];
        const handler = handlers.get(type);

        if (!handler) {
            throw new Error(`no ${type} handler`);
        }

        handler({
            ...event,
            waitUntil: (promise) => void waited.push(promise),
        });
        await Promise.all(waited);
    }

    const push = (payload: unknown) =>
        fire('push', {
            data: { json: () => payload, text: () => JSON.stringify(payload) },
        });

    return {
        handlers,
        notifications,
        visible: () => notifications.filter((n) => !n.closed),
        fetchMock,
        clients,
        scope,
        subscribe,
        fire,
        push,
    };
}

const offer = (extra: Record<string, unknown> = {}) => ({
    v: 1,
    title: 'New chat request',
    body: 'Billing - Hello there',
    renotify: false,
    requireInteraction: true,
    data: { url: '/inbox/01jchat', tag: 'offer-01jchat', type: 'offer' },
    ...extra,
});

describe('the worker file', () => {
    it('handles push, clicks and subscription changes only: no fetch handler, no caching', () => {
        const worker = loadWorker();

        expect([...worker.handlers.keys()].sort()).toEqual([
            'activate',
            'install',
            'notificationclick',
            'push',
            'pushsubscriptionchange',
        ]);
        expect(SOURCE).not.toMatch(
            /caches\b|CacheStorage|addEventListener\('fetch'/,
        );
    });

    it('takes over at once', async () => {
        const worker = loadWorker();

        await worker.fire('install');
        await worker.fire('activate');

        expect(worker.scope.skipWaiting).toHaveBeenCalled();
        expect(worker.clients.claim).toHaveBeenCalled();
    });
});

describe('push: showing a notification', () => {
    it('shows an offer with its tag, icon, badge and where a click goes', async () => {
        const worker = loadWorker();

        await worker.push(offer());

        expect(worker.notifications).toHaveLength(1);
        expect(worker.notifications[0].title).toBe('New chat request');
        expect(worker.notifications[0].options).toEqual({
            body: 'Billing - Hello there',
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            requireInteraction: true,
            tag: 'offer-01jchat',
            renotify: false,
            data: {
                url: '/inbox/01jchat',
                tag: 'offer-01jchat',
                type: 'offer',
            },
        });
    });

    it('re-alerts for the next message of the same chat (renotify) and replaces the previous one', async () => {
        const worker = loadWorker();
        const message = (body: string) => ({
            v: 1,
            title: 'New message from Ann',
            body,
            renotify: true,
            requireInteraction: false,
            data: {
                url: '/inbox/01jchat',
                tag: 'chat-01jchat',
                type: 'message',
            },
        });

        await worker.push(message('first'));
        await worker.push(message('second'));

        expect(worker.visible()).toHaveLength(1);
        expect(worker.visible()[0].options.body).toBe('second');
        expect(worker.visible()[0].options.renotify).toBe(true);
    });

    it('shows a generic notification for a payload it cannot read (browsers insist on a visible one)', async () => {
        const worker = loadWorker();

        await worker.fire('push', {
            data: {
                json: () => {
                    throw new Error('not json');
                },
                text: () => 'plain words',
            },
        });
        await worker.fire('push', { data: null });

        expect(worker.notifications.map((n) => n.title)).toEqual([
            'plain words',
            'New notification',
        ]);
    });

    it('leaves out renotify without a tag instead of throwing', async () => {
        const worker = loadWorker();

        await worker.push({
            title: 'Hi',
            body: '',
            renotify: true,
            data: { url: '/inbox' },
        });

        expect(worker.notifications[0].options).not.toHaveProperty('tag');
        expect(worker.notifications[0].options).not.toHaveProperty('renotify');
    });

    it.each([
        [
            'an absolute URL of another site',
            'https://evil.example/phish',
            '/inbox',
        ],
        ['a protocol-relative URL', '//evil.example/phish', '/inbox'],
        ['a javascript: URL', 'javascript:alert(1)', '/inbox'],
        ['no URL at all', undefined, '/inbox'],
        [
            'a path with a query and a hash',
            '/inbox/01jchat?from=push#top',
            '/inbox/01jchat?from=push#top',
        ],
        [
            'an absolute URL of this site',
            `${ORIGIN}/inbox/01jchat`,
            '/inbox/01jchat',
        ],
    ])('only ever opens this site: %s', async (_label, url, expected) => {
        const worker = loadWorker();

        await worker.push(offer({ data: { url, tag: 't', type: 'offer' } }));

        expect(
            (worker.notifications[0].options.data as { url: string }).url,
        ).toBe(expected);
    });
});

describe('push: the silent dismiss', () => {
    const dismiss = (tag: string) => ({
        v: 1,
        data: { url: '/inbox', tag, type: 'dismiss' },
    });

    it('closes the notification with that tag and leaves the others', async () => {
        const worker = loadWorker();
        await worker.push(offer());
        await worker.push(
            offer({
                data: { url: '/inbox/02', tag: 'offer-02', type: 'offer' },
            }),
        );

        await worker.push(dismiss('offer-01jchat'));

        expect(worker.visible().map((n) => n.options.tag)).toEqual([
            'offer-02',
        ]);
    });

    it('shows nothing that stays: browsers insist on a visible notification per push, so a silent one is shown and taken down at once', async () => {
        const worker = loadWorker();
        await worker.push(offer());

        await worker.push(dismiss('offer-01jchat'));

        const transient = worker.notifications.find(
            (n) => n.options.tag === 'pne-dismiss',
        );
        expect(transient).toBeDefined();
        expect(transient?.options.silent).toBe(true);
        expect(transient?.closed).toBe(true);
        expect(worker.visible()).toHaveLength(0);
    });

    it('does not throw when the notification is already gone or the tag is missing', async () => {
        const worker = loadWorker();

        await worker.push(dismiss('offer-already-clicked'));
        await worker.push({ v: 1, data: { type: 'dismiss' } });

        expect(worker.visible()).toHaveLength(0);
    });
});

describe('notificationclick', () => {
    const click = (
        worker: ReturnType<typeof loadWorker>,
        url: string | null = '/inbox/01jchat',
    ) => {
        const notification = {
            close: vi.fn(),
            data: url === null ? {} : { url },
        };

        return worker
            .fire('notificationclick', { notification })
            .then(() => notification);
    };

    it('closes the notification and focuses the open dashboard, which is told where to go', async () => {
        const dashboard = client(`${ORIGIN}/dashboard`);
        const worker = loadWorker({ clients: [dashboard] });

        const notification = await click(worker);

        expect(notification.close).toHaveBeenCalled();
        expect(dashboard.focus).toHaveBeenCalled();
        expect(dashboard.postMessage).toHaveBeenCalledWith({
            type: 'pne:open',
            url: '/inbox/01jchat',
        });
        expect(worker.clients.openWindow).not.toHaveBeenCalled();
    });

    it('prefers the focused window, then a visible one, over the others', async () => {
        const hidden = client(`${ORIGIN}/inbox`);
        const visible = client(`${ORIGIN}/history`, {
            visibilityState: 'visible',
        });
        const focused = client(`${ORIGIN}/inbox/other`, {
            focused: true,
            visibilityState: 'visible',
        });

        await click(loadWorker({ clients: [hidden, visible, focused] }));
        expect(focused.focus).toHaveBeenCalled();
        expect(hidden.focus).not.toHaveBeenCalled();

        const second = loadWorker({ clients: [hidden, visible] });
        await click(second);
        expect(visible.focus).toHaveBeenCalled();
    });

    it('never navigates a visitor chat page, the installer or another site: it opens a new window instead', async () => {
        const worker = loadWorker({
            clients: [
                client(`${ORIGIN}/embed/abc123`),
                client(`${ORIGIN}/c/abc123`),
                client(`${ORIGIN}/setup`),
                client('https://customer.example/support'),
            ],
        });

        await click(worker);

        expect(worker.clients.openWindow).toHaveBeenCalledWith(
            '/inbox/01jchat',
        );
    });

    it('opens a window when no dashboard is open', async () => {
        const worker = loadWorker();

        await click(worker, '/inbox');

        expect(worker.clients.openWindow).toHaveBeenCalledWith('/inbox');
    });

    it('opens a window when the open one cannot be focused', async () => {
        const stubborn = client(`${ORIGIN}/dashboard`, {
            focus: vi.fn(async () => {
                throw new Error('not allowed');
            }),
        });
        const worker = loadWorker({ clients: [stubborn] });

        await click(worker);

        expect(worker.clients.openWindow).toHaveBeenCalledWith(
            '/inbox/01jchat',
        );
    });

    it('falls back to the inbox for a notification without data or with a foreign URL', async () => {
        const noData = loadWorker();
        await click(noData, null);
        expect(noData.clients.openWindow).toHaveBeenCalledWith('/inbox');

        const foreign = loadWorker();
        await click(foreign, 'https://evil.example/x');
        expect(foreign.clients.openWindow).toHaveBeenCalledWith('/inbox');
    });
});

describe('pushsubscriptionchange', () => {
    const key = new Uint8Array([4, 1, 2, 3]).buffer;

    it('subscribes again with the old key, registers the new subscription and tells the open pages', async () => {
        const dashboard = client(`${ORIGIN}/dashboard`);
        const worker = loadWorker({
            clients: [dashboard],
            cookies: { 'XSRF-TOKEN': 'token-123' },
        });

        await worker.fire('pushsubscriptionchange', {
            oldSubscription: { options: { applicationServerKey: key } },
        });

        expect(worker.subscribe).toHaveBeenCalledWith({
            userVisibleOnly: true,
            applicationServerKey: key,
        });
        const [url, init] = worker.fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe('/api/v1/me/push-subscriptions');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect((init.headers as Record<string, string>)['X-XSRF-TOKEN']).toBe(
            'token-123',
        );
        expect(JSON.parse(init.body as string).endpoint).toBe(
            'https://fcm.googleapis.com/fcm/send/fresh',
        );
        expect(dashboard.postMessage).toHaveBeenCalledWith({
            type: 'pne:subscription-changed',
        });
    });

    it('uses the subscription the browser already made (newSubscription) without subscribing again', async () => {
        const worker = loadWorker();
        const newSubscription = {
            toJSON: () => ({
                endpoint: 'https://fcm.googleapis.com/fcm/send/new',
                keys: { p256dh: 'p', auth: 'a' },
            }),
        };

        await worker.fire('pushsubscriptionchange', { newSubscription });

        expect(worker.subscribe).not.toHaveBeenCalled();
        expect(worker.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still tells the pages when it cannot register (no cookie API, the network down, nothing to resubscribe)', async () => {
        const dashboard = client(`${ORIGIN}/dashboard`);
        const worker = loadWorker({ clients: [dashboard] });
        worker.fetchMock.mockRejectedValue(new Error('offline'));

        await worker.fire('pushsubscriptionchange', {
            oldSubscription: { options: { applicationServerKey: key } },
        });
        const withoutKey = loadWorker({ clients: [dashboard] });
        await withoutKey.fire('pushsubscriptionchange', {});

        expect(dashboard.postMessage).toHaveBeenCalledTimes(2);
        expect(withoutKey.fetchMock).not.toHaveBeenCalled();
    });
});

beforeEach(() => {
    vi.restoreAllMocks();
});
