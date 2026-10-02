/**
 * Web push in the e2e suite, with the real server and the real service worker but NO vendor push service (Chrome in a test has none).
 *
 * What stands in for what:
 *
 *  - `FakePushService`: an https server on the scenario's push port (`Instance.push.port`), the "push service" the server posts to. It records
 *    every request (path, headers, body), answers 201 (or any status a spec sets per subscription: 410 = the browser dropped it), and, since the
 *    subscription's keys are the spec's own, DECRYPTS the body (RFC 8291, `aes128gcm`) and checks the VAPID header. The server trusts its
 *    throw-away certificate through the scenario's own `php.ini` (push-trust.ts); the SSRF guard lets 127.0.0.1 through because the scenarios
 *    run `APP_ENV=local`. No product code knows about any of this.
 *  - `FakeSubscription`: an endpoint on that service plus a key pair and an auth secret, in the shape of a browser `PushSubscription`.
 *  - `installPushStub()`: in the PAGE, `PushManager.subscribe()` / `getSubscription()` hand out that subscription (the real call has no push
 *    service to talk to in headless Chrome and rejects). It survives reloads like a real subscription does (kept in localStorage).
 *  - `installPermissionStub()`: in the page, `Notification.permission` / `requestPermission()` are controllable and counted, so a spec can prove
 *    the browser's prompt is only ever asked for on a click. Real-browser specs (the service worker) use `context.grantPermissions()` instead.
 *  - `ServiceWorkerDriver`: the REAL `public/sw.js` in the real browser, driven through the Chrome DevTools Protocol (`ServiceWorker.deliverPushMessage`
 *    is what a push service's message becomes) and Playwright's service-worker handle.
 */
import {
    createECDH,
    createDecipheriv,
    createPublicKey,
    createVerify,
    hkdfSync,
    randomBytes,
    type ECDH,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type {
    BrowserContext,
    CDPSession,
    Page,
    Worker,
} from '@playwright/test';
import { PUSH_CERT, PUSH_KEY } from './push-trust';
import { vapidKeys, type Instance } from './scenarios';

const b64url = (bytes: Buffer): string => bytes.toString('base64url');

/** What a browser's `PushSubscription.toJSON()` holds. */
export type SubscriptionJson = {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
};

/** One request the server made to the fake push service. */
export type PushRequest = {
    /** The subscription id in the path (`/send/<id>`). */
    id: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    at: number;
};

export type DecodedPush = {
    v: number;
    title?: string;
    body?: string;
    renotify?: boolean;
    requireInteraction?: boolean;
    data: {
        url: string;
        tag: string;
        type: 'offer' | 'message' | 'test' | 'dismiss';
    };
};

/** An endpoint on the fake service with the receiver's keys (what a browser generates and keeps). */
export class FakeSubscription {
    private readonly ecdh: ECDH;
    readonly p256dh: string;
    readonly auth: string;
    private readonly authBytes: Buffer;

    constructor(
        readonly id: string,
        readonly endpoint: string,
    ) {
        this.ecdh = createECDH('prime256v1');
        this.ecdh.generateKeys();
        this.p256dh = b64url(this.ecdh.getPublicKey());
        this.authBytes = randomBytes(16);
        this.auth = b64url(this.authBytes);
    }

    /**
     * A subscription whose endpoint nobody listens on (`https://127.0.0.1:8409/...`: the port no scenario uses): to the server it is a valid
     * public-enough endpoint, and every push to it is refused at the connection, which the server reports as a failed delivery.
     */
    static dead(): FakeSubscription {
        const id = `dead${randomBytes(6).toString('hex')}`;

        return new FakeSubscription(id, `https://127.0.0.1:8409/send/${id}`);
    }

    toJSON(): SubscriptionJson {
        return {
            endpoint: this.endpoint,
            expirationTime: null,
            keys: { p256dh: this.p256dh, auth: this.auth },
        };
    }

    /**
     * Decrypts a push body as the browser would (RFC 8291 over RFC 8188: one `aes128gcm` record, the sender's key id inside the header).
     * Returns the JSON the service worker receives.
     */
    decrypt(body: Buffer): DecodedPush {
        const salt = body.subarray(0, 16);
        const keyIdLength = body[20];
        const senderKey = body.subarray(21, 21 + keyIdLength);
        const record = body.subarray(21 + keyIdLength);
        const secret = this.ecdh.computeSecret(senderKey);
        const keyInfo = Buffer.concat([
            Buffer.from('WebPush: info\0'),
            this.ecdh.getPublicKey(),
            senderKey,
        ]);
        const ikm = Buffer.from(
            hkdfSync('sha256', secret, this.authBytes, keyInfo, 32),
        );
        const key = Buffer.from(
            hkdfSync(
                'sha256',
                ikm,
                salt,
                Buffer.from('Content-Encoding: aes128gcm\0'),
                16,
            ),
        );
        const nonce = Buffer.from(
            hkdfSync(
                'sha256',
                ikm,
                salt,
                Buffer.from('Content-Encoding: nonce\0'),
                12,
            ),
        );
        const decipher = createDecipheriv('aes-128-gcm', key, nonce);

        decipher.setAuthTag(record.subarray(record.length - 16));

        const plain = Buffer.concat([
            decipher.update(record.subarray(0, record.length - 16)),
            decipher.final(),
        ]);
        // The record ends with the delimiter 0x02 (last record) and zero padding.
        let end = plain.length;

        while (end > 0 && plain[end - 1] === 0) {
            end -= 1;
        }

        if (plain[end - 1] !== 2) {
            throw new Error('The push record has no final delimiter.');
        }

        return JSON.parse(
            plain.subarray(0, end - 1).toString('utf8'),
        ) as DecodedPush;
    }
}

export class FakePushService {
    readonly requests: PushRequest[] = [];
    private readonly subscriptions = new Map<string, FakeSubscription>();
    private readonly answers = new Map<string, number>();
    private sequence = 0;

    private constructor(
        private readonly server: Server,
        readonly origin: string,
    ) {}

    /** Starts it on the scenario's push port (the port belongs to ONE scenario instance: only one service runs there at a time). */
    static async start(instance: Instance): Promise<FakePushService> {
        const port = instance.push?.port ?? null;

        if (port === null) {
            throw new Error(
                `Scenario ${instance.key} has no push service port.`,
            );
        }

        let service!: FakePushService;
        const server = createServer(
            { key: readFileSync(PUSH_KEY), cert: readFileSync(PUSH_CERT) },
            (request, response) => {
                const chunks: Buffer[] = [];

                request.on('data', (chunk: Buffer) => chunks.push(chunk));
                request.on('end', () => {
                    const id =
                        (request.url ?? '').split('/').pop()?.split('?')[0] ??
                        '';

                    service.requests.push({
                        id,
                        method: request.method ?? '',
                        headers: request.headers,
                        body: Buffer.concat(chunks),
                        at: Date.now(),
                    });
                    response.statusCode = service.answers.get(id) ?? 201;
                    response.end();
                });
            },
        );

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => resolve());
        });
        service = new FakePushService(server, `https://127.0.0.1:${port}`);

        return service;
    }

    /** A new subscription on this service (its endpoint is a path of its own). */
    subscribe(): FakeSubscription {
        this.sequence += 1;

        const id = `sub${Date.now().toString(36)}${this.sequence}${randomBytes(3).toString('hex')}`;
        const subscription = new FakeSubscription(
            id,
            `${this.origin}/send/${id}`,
        );

        this.subscriptions.set(id, subscription);

        return subscription;
    }

    /** What the service answers for this subscription from now on (201 default; 410 = the browser dropped it, 404 likewise, 5xx = retry). */
    answer(subscription: FakeSubscription, status: number): void {
        this.answers.set(subscription.id, status);
    }

    /** The requests made for one subscription, oldest first. */
    requestsFor(subscription: FakeSubscription): PushRequest[] {
        return this.requests.filter(
            (request) => request.id === subscription.id,
        );
    }

    /** The decrypted messages the server sent to one subscription, oldest first. */
    messagesFor(subscription: FakeSubscription): DecodedPush[] {
        return this.requestsFor(subscription).map((request) =>
            subscription.decrypt(request.body),
        );
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) =>
            this.server.close(() => resolve()),
        );
        this.server.closeAllConnections();
    }
}

/**
 * Checks the VAPID `Authorization` header of a push request (RFC 8292, `vapid t=<jwt>, k=<public key>`): the key is the instance's,
 * the JWT is signed by it (ES256), names the push service as audience, expires within a day and carries a `mailto:` / https subject.
 */
export function checkVapid(
    request: PushRequest,
    instance: Instance,
): {
    aud: string;
    sub: string;
    exp: number;
} {
    const header = String(request.headers.authorization ?? '');
    const token = /t=([\w-]+\.[\w-]+\.[\w-]+)/.exec(header)?.[1];
    const key = /k=([\w-]+)/.exec(header)?.[1];

    if (!token || !key) {
        throw new Error(`No VAPID header: ${header}`);
    }

    const { publicKey } = vapidKeys();

    if (key !== publicKey) {
        throw new Error(
            "The VAPID public key in the header is not the instance's.",
        );
    }

    const [head, claims, signature] = token.split('.');
    const raw = Buffer.from(publicKey, 'base64url');
    const spki = createPublicKey({
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: b64url(raw.subarray(1, 33)),
            y: b64url(raw.subarray(33, 65)),
        },
        format: 'jwk',
    });
    const verifier = createVerify('SHA256');

    verifier.update(`${head}.${claims}`);

    if (
        !verifier.verify(
            { key: spki, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64url'),
        )
    ) {
        throw new Error('The VAPID JWT signature does not verify.');
    }

    void instance;

    return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
}

/**
 * `PushManager.subscribe()` / `getSubscription()` of the page return `subscription` (kept in localStorage so a reload keeps it, like the
 * browser would). `window.__pushStub` says how often the page subscribed / unsubscribed and with which key. Call before the page loads.
 */
export async function installPushStub(
    target: { addInitScript: Page['addInitScript'] },
    subscription: SubscriptionJson | null,
): Promise<void> {
    await target.addInitScript((initial) => {
        const storageKey = '__fakePushSubscription';
        const log = { subscribed: 0, unsubscribed: 0, keys: [] as string[] };

        (window as unknown as Record<string, unknown>).__pushStub = log;

        if (initial !== null && localStorage.getItem(storageKey) === null) {
            localStorage.setItem(
                storageKey,
                JSON.stringify({ ...initial, key: null }),
            );
        }

        const bytes = (base64Url: string): ArrayBuffer => {
            const padded = base64Url
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
            const raw = atob(padded);
            const out = new Uint8Array(raw.length);

            for (let index = 0; index < raw.length; index++) {
                out[index] = raw.charCodeAt(index);
            }

            return out.buffer;
        };

        const make = (stored: {
            endpoint: string;
            keys: { p256dh: string; auth: string };
            key: string | null;
        }) => ({
            endpoint: stored.endpoint,
            expirationTime: null,
            options: {
                userVisibleOnly: true,
                applicationServerKey:
                    stored.key === null ? null : bytes(stored.key),
            },
            getKey: (name: string) =>
                bytes(
                    name === 'p256dh' ? stored.keys.p256dh : stored.keys.auth,
                ),
            toJSON: () => ({
                endpoint: stored.endpoint,
                expirationTime: null,
                keys: stored.keys,
            }),
            unsubscribe: async () => {
                log.unsubscribed += 1;
                localStorage.removeItem(storageKey);

                return true;
            },
        });

        const read = () => {
            const raw = localStorage.getItem(storageKey);

            return raw === null ? null : JSON.parse(raw);
        };

        PushManager.prototype.getSubscription = async function () {
            const stored = read();

            return stored === null
                ? null
                : (make(stored) as unknown as PushSubscription);
        };
        PushManager.prototype.subscribe = async function (
            options?: PushSubscriptionOptionsInit,
        ) {
            const stored = read();
            const key =
                options?.applicationServerKey instanceof ArrayBuffer ||
                ArrayBuffer.isView(options?.applicationServerKey)
                    ? btoa(
                          String.fromCharCode(
                              ...new Uint8Array(
                                  options!.applicationServerKey as ArrayBuffer,
                              ),
                          ),
                      )
                          .replace(/\+/g, '-')
                          .replace(/\//g, '_')
                          .replace(/=+$/, '')
                    : null;

            log.subscribed += 1;

            if (key !== null) {
                log.keys.push(key);
            }

            const base =
                stored ??
                (window as unknown as { __nextSubscription?: unknown })
                    .__nextSubscription;

            if (!base) {
                throw new DOMException(
                    'No fake subscription was prepared',
                    'AbortError',
                );
            }

            const next = { ...(base as object), key } as Parameters<
                typeof make
            >[0];

            localStorage.setItem(storageKey, JSON.stringify(next));

            return make(next) as unknown as PushSubscription;
        };
    }, subscription);
}

/** Hands the page the subscription its next `subscribe()` returns (when `installPushStub` was given none up front). */
export async function prepareSubscription(
    page: Page,
    subscription: SubscriptionJson,
): Promise<void> {
    await page.evaluate((next) => {
        (
            window as unknown as { __nextSubscription?: unknown }
        ).__nextSubscription = next;
    }, subscription);
}

export type PushStubLog = {
    subscribed: number;
    unsubscribed: number;
    keys: string[];
};

export function pushStubLog(page: Page): Promise<PushStubLog> {
    return page.evaluate(
        () => (window as unknown as { __pushStub: PushStubLog }).__pushStub,
    );
}

export type PermissionAnswer = 'granted' | 'denied' | 'dismiss';

/**
 * Makes the browser's notification permission scriptable: `Notification.permission` starts as `initial`, `requestPermission()` is counted
 * (`window.__perm.requests`) and answers `answer` (`dismiss` closes the prompt with no decision: the permission stays `default`). The page
 * the app runs in sees a normal `Notification` API; `new Notification()` is recorded in `window.__notifications` (title, options) instead of
 * showing anything, so a spec can look at what the page itself would show, and click it. Call before the page loads.
 */
export async function installPermissionStub(
    target: { addInitScript: Page['addInitScript'] },
    options: {
        initial?: NotificationPermission;
        answer?: PermissionAnswer;
    } = {},
): Promise<void> {
    await target.addInitScript(
        (config) => {
            // A browser remembers the permission for the site: it survives reloads (and is per origin, like localStorage).
            const saved = localStorage.getItem('__fakePermission');
            const state = {
                permission: (saved ?? config.initial) as NotificationPermission,
                answer: config.answer as string,
                requests: 0,
            };
            const shown: {
                title: string;
                options: Record<string, unknown>;
                closed: boolean;
                click: () => void;
            }[] = [];

            (window as unknown as Record<string, unknown>).__perm = state;
            (window as unknown as Record<string, unknown>).__notifications =
                shown;

            class FakeNotification {
                static get permission(): NotificationPermission {
                    return state.permission;
                }

                static requestPermission(
                    callback?: (permission: NotificationPermission) => void,
                ): Promise<NotificationPermission> {
                    state.requests += 1;

                    if (
                        state.answer === 'granted' ||
                        state.answer === 'denied'
                    ) {
                        state.permission = state.answer;
                        localStorage.setItem('__fakePermission', state.answer);
                    }

                    callback?.(state.permission);

                    return Promise.resolve(state.permission);
                }

                onclick: ((event: Event) => void) | null = null;
                private entry: (typeof shown)[number];

                constructor(
                    title: string,
                    notificationOptions: Record<string, unknown> = {},
                ) {
                    this.entry = {
                        title,
                        options: notificationOptions,
                        closed: false,
                        click: () => this.onclick?.(new Event('click')),
                    };
                    shown.push(this.entry);
                }

                close(): void {
                    this.entry.closed = true;
                }
            }

            Object.defineProperty(window, 'Notification', {
                configurable: true,
                writable: true,
                value: FakeNotification,
            });
        },
        {
            initial: options.initial ?? 'default',
            answer: options.answer ?? 'granted',
        },
    );
}

export type StubbedNotification = {
    title: string;
    options: { body?: string; tag?: string };
    closed: boolean;
};

/** The notifications the page itself showed (`new Notification()`), oldest first (needs `installPermissionStub`). */
export async function pageNotifications(
    page: Page,
): Promise<StubbedNotification[]> {
    return page.evaluate(() =>
        (
            (window as unknown as Record<string, unknown>)
                .__notifications as StubbedNotification[]
        ).map(({ title, options, closed }) => ({
            title,
            options: options as { body?: string; tag?: string },
            closed,
        })),
    );
}

/** Clicks the page notification at this index (what the person's click on the OS notification does). */
export async function clickPageNotification(
    page: Page,
    index: number,
): Promise<void> {
    await page.evaluate((position) => {
        const list = (window as unknown as Record<string, unknown>)
            .__notifications as { click: () => void }[];

        list[position].click();
    }, index);
}

export async function permissionRequests(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            (window as unknown as { __perm: { requests: number } }).__perm
                .requests,
    );
}

/** One `showNotification(title, options)` call of the worker (`ServiceWorkerDriver.record()`). */
export type RecordedNotification = {
    title: string;
    options: {
        body?: string;
        tag?: string;
        icon?: string;
        badge?: string;
        silent?: boolean;
        renotify?: boolean;
        requireInteraction?: boolean;
        data?: { url?: string; tag?: string; type?: string };
    };
};

/** A notification as `registration.getNotifications()` reports it (what the real service worker showed). */
export type ShownNotification = {
    title: string;
    body: string;
    tag: string;
    silent: boolean | null;
    requireInteraction: boolean;
    renotify: boolean;
    icon: string;
    data: { url?: string; tag?: string; type?: string } | null;
};

/**
 * The REAL `public/sw.js` of a page's browser, driven from the test. Needs the real notification permission
 * (`context.grantPermissions(['notifications'], { origin })`) and a page of the app (the dashboard registers the worker itself; with the
 * push stub it also subscribes). `deliver()` is `ServiceWorker.deliverPushMessage`: what the push service's message to this browser becomes.
 */
export class ServiceWorkerDriver {
    private registrationId: string | null = null;

    private constructor(
        readonly page: Page,
        private readonly cdp: CDPSession,
        readonly origin: string,
    ) {}

    static async attach(
        page: Page,
        instance: Instance,
    ): Promise<ServiceWorkerDriver> {
        const cdp = await page.context().newCDPSession(page);
        const driver = new ServiceWorkerDriver(page, cdp, instance.url);

        cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
            for (const registration of event.registrations) {
                if (
                    registration.scopeURL === `${instance.url}/` &&
                    !registration.isDeleted
                ) {
                    driver.registrationId = registration.registrationId;
                }
            }
        });
        await cdp.send('ServiceWorker.enable');

        return driver;
    }

    /** The worker that controls the dashboard, once it is running (Playwright's handle: `evaluate` runs inside it). */
    async worker(): Promise<Worker> {
        const context: BrowserContext = this.page.context();

        for (let attempt = 0; attempt < 100; attempt += 1) {
            const found = context
                .serviceWorkers()
                .find((worker) => worker.url() === `${this.origin}/sw.js`);

            if (found) {
                return found;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new Error('The service worker never started.');
    }

    /** Waits until the registration exists and the worker is activated (the page registers it a moment after it loads). */
    async ready(): Promise<void> {
        await this.page.evaluate(async () => {
            await navigator.serviceWorker.ready;
        });

        for (
            let attempt = 0;
            attempt < 100 && this.registrationId === null;
            attempt += 1
        ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (this.registrationId === null) {
            throw new Error(
                'No service worker registration for the scope was reported.',
            );
        }

        await this.worker();
    }

    /** Delivers a push message (the JSON the server would have sent) to the worker, as the browser's push machinery does. */
    async deliver(
        payload: DecodedPush | Record<string, unknown> | string,
    ): Promise<void> {
        await this.ready();
        await this.cdp.send('ServiceWorker.deliverPushMessage', {
            origin: this.origin,
            registrationId: this.registrationId!,
            data:
                typeof payload === 'string' ? payload : JSON.stringify(payload),
        });
    }

    /**
     * Records every `registration.showNotification()` call the worker makes from now on (title and options as the worker passed them).
     * Headless Chrome closes a notification that is not `requireInteraction` the moment it shows it, so `notifications()` only ever lists
     * the ones that stay; this says what the worker ASKED the browser to show, whatever the browser did with it. Call it after `ready()`
     * and before the push (a worker the browser has stopped and restarted forgets it: tests are short). Idempotent.
     */
    async record(): Promise<void> {
        const worker = await this.worker();

        await worker.evaluate(() => {
            const scope = self as unknown as {
                __shown?: { title: string; options: Record<string, any> }[];
                registration: ServiceWorkerRegistration;
            };

            if (scope.__shown) {
                return;
            }

            scope.__shown = [];

            const original = scope.registration.showNotification.bind(
                scope.registration,
            );

            scope.registration.showNotification = (title, options) => {
                scope.__shown!.push({
                    title,
                    options: JSON.parse(JSON.stringify(options ?? {})),
                });

                return original(title, options);
            };
        });
    }

    /** What `record()` saw, oldest first (optionally one tag). The transient notification of a dismiss is in there too (tag `pne-dismiss`). */
    async shown(tag?: string): Promise<RecordedNotification[]> {
        const worker = await this.worker();
        const list = await worker.evaluate(
            () =>
                (
                    self as unknown as {
                        __shown?: RecordedNotification[];
                    }
                ).__shown ?? [],
        );

        return tag === undefined
            ? list
            : list.filter((item) => item.options.tag === tag);
    }

    /** The notifications the worker has shown and not yet closed (optionally one tag). */
    async notifications(tag?: string): Promise<ShownNotification[]> {
        return this.page.evaluate(async (wanted) => {
            const registration =
                await navigator.serviceWorker.getRegistration('/');
            const list = await registration!.getNotifications(
                wanted ? { tag: wanted } : {},
            );

            return list.map((notification) => ({
                title: notification.title,
                body: notification.body,
                tag: notification.tag,
                silent: notification.silent,
                requireInteraction: notification.requireInteraction,
                renotify: (notification as unknown as { renotify: boolean })
                    .renotify,
                icon: notification.icon,
                data: notification.data as ShownNotification['data'],
            }));
        }, tag);
    }

    async detach(): Promise<void> {
        await this.cdp.detach().catch(() => undefined);
    }
}
