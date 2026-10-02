import { test as base } from '../support/test';
import { must } from '../support/chat-api';
import {
    endpointHash,
    expect,
    expectEventually,
    prepareBrowser,
    pushDevices,
    takeNotificationCentre,
} from '../support/notify';
import { setVisibility } from '../support/presence';
import {
    FakeSubscription,
    ServiceWorkerDriver,
    surviveWipes,
    type DecodedPush,
} from '../support/push';
import { readSeed } from '../support/chat-seed';
import { createWorld } from '../support/world';
import type { Actors, StaffActor } from '../support/actors';
import type { Api } from '../support/api';
import type { Instance } from '../support/scenarios';

/**
 * `public/sw.js` in a REAL browser (decision P5-D6): the dashboard registers it, Chrome runs it, and the spec drives it through the Chrome
 * DevTools Protocol: `ServiceWorker.deliverPushMessage` is exactly what a push service's message to this browser becomes, so the worker's `push`
 * handler runs for real and `registration.getNotifications()` says what it showed. `notificationclick` and `pushsubscriptionchange` cannot be
 * produced from outside (nothing in headless Chrome clicks an OS notification, and a browser only rotates a subscription by itself): the spec
 * dispatches those two events INSIDE the worker with a stand-in event object, replaces only what a browser allows solely for a real user
 * gesture (`WindowClient.focus`, `clients.openWindow`) with recorders, and lets everything else run for real (the window search, `postMessage`
 * to the dashboard, the dashboard's own navigation, the fetch with the session cookie and the XSRF token). The notification permission is the
 * browser's real one (`grantPermissions`); only `PushManager.subscribe` is a stub (there is no push service here).
 */
const test = base.extend<{ notificationCentre: void }>({
    // The browser's display of notifications is shared with every other Chrome here: one test at a time (see takeNotificationCentre).
    notificationCentre: [
        async ({ instance: _instance }, use) => {
            const release = await takeNotificationCentre();

            try {
                await use();
            } finally {
                release();
            }
        },
        { auto: true, timeout: 600_000 },
    ],
});

test.use({ scenario: 'p5-notify' });

test.describe.configure({ timeout: 120_000 });

type Rig = { actors: Actors; adminApi: Api; instance: Instance };

/** An agent with the real permission granted, the dashboard open, the worker registered and the push stub subscribed. */
async function withWorker(
    rig: Rig,
    options: { visibility?: boolean } = {},
): Promise<{
    ann: StaffActor;
    driver: ServiceWorkerDriver;
    subscription: FakeSubscription;
    ulid: string;
}> {
    const world = await createWorld(rig.adminApi, rig.instance, {
        agents: { ann: ['main'] },
    });
    const ann = await rig.actors.account(world.agents.ann);
    const subscription = FakeSubscription.dead();

    await ann.context.grantPermissions(['notifications'], {
        origin: rig.instance.url,
    });
    await prepareBrowser(ann, {
        permission: 'real',
        subscription,
        visibility: options.visibility,
    });
    await ann.inbox.goto();

    const driver = await ServiceWorkerDriver.attach(ann.page, rig.instance);

    await driver.ready();

    return {
        ann,
        driver,
        subscription,
        ulid: '01hz8w3q4n5p6r7s8t9v0x1y2z',
    };
}

const offer = (
    ulid: string,
    body = 'Billing - Do you ship to Oslo?',
): DecodedPush => ({
    v: 1,
    title: 'New chat request',
    body,
    renotify: false,
    requireInteraction: true,
    data: { url: `/inbox/${ulid}`, tag: `offer-${ulid}`, type: 'offer' },
});

test('the dashboard registers the worker at the root scope: it controls the page, has no fetch handler and caches nothing', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann, subscription } = await withWorker({
        actors,
        adminApi,
        instance,
    });
    const registration = await ann.page.evaluate(async () => {
        const found = await navigator.serviceWorker.getRegistration('/');

        return {
            scope: found?.scope,
            script: found?.active?.scriptURL,
            state: found?.active?.state,
            updateViaCache: found?.updateViaCache,
            caches: await caches.keys(),
            permission: Notification.permission,
        };
    });

    expect(registration.scope).toBe(`${instance.url}/`);
    expect(registration.script).toBe(`${instance.url}/sw.js`);
    expect(registration.state).toBe('activated');
    expect(registration.updateViaCache).toBe('none');
    expect(registration.caches).toEqual([]);
    expect(registration.permission).toBe('granted');

    // The script is served as a plain static file and does not sit between the page and the network.
    const response = await ann.page.request.get(`${instance.url}/sw.js`);
    const source = await response.text();

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/javascript/);
    expect(source).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(source).not.toMatch(/caches\./);

    // The browser was subscribed with the stub and registered on the server.
    await expectEventually(
        () => pushDevices(ann),
        (devices) =>
            devices.some(
                (device) =>
                    device.endpointHash === endpointHash(subscription.endpoint),
            ),
        { timeout: 45_000, message: 'the browser was registered' },
    );
});

test('a pushed offer is shown by the real worker with its title, body, tag, icon and the path to open; the same tag replaces it, and a message is renotified', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { driver, ulid } = await withWorker({ actors, adminApi, instance });

    await driver.record();

    // What the browser displays can be wiped by anything else closing a browser context on this machine: such an attempt is run again
    // (support/push.ts `surviveWipes`), with tags of its own.
    await surviveWipes(async (attempt) => {
        const id = `${ulid.slice(0, -1)}${attempt}`;
        const tag = `offer-${id}`;
        const mark = await driver.mark();

        await driver.deliver(offer(id));

        const first = (await driver.awaitListed([tag], mark)).filter(
            (item) => item.tag === tag,
        );

        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            title: 'New chat request',
            body: 'Billing - Do you ship to Oslo?',
            tag,
            requireInteraction: true,
            data: { url: `/inbox/${id}`, tag, type: 'offer' },
        });
        expect(first[0].icon).toBe(`${instance.url}/icons/icon-192.png`);

        // The same tag again (the page's own notification, a second wave): ONE notification, the newer text.
        await driver.deliver(offer(id, 'Billing - Still waiting'));
        await driver.awaitListed([tag], mark, {
            where: (list) => {
                const mine = list.filter((item) => item.tag === tag);

                return (
                    mine.length === 1 &&
                    mine[0].body === 'Billing - Still waiting'
                );
            },
        });
    });

    // A message push: tag chat-<ulid>, renotify on (the browser alerts again for the newest message of the same chat). It is not
    // `requireInteraction`, which headless Chrome closes at once, so what is checked is what the worker asked the browser to show.
    const chatTag = `chat-${ulid}`;
    const message = (body: string): DecodedPush => ({
        v: 1,
        title: 'New message from Max',
        body,
        renotify: true,
        requireInteraction: false,
        data: { url: `/inbox/${ulid}`, tag: chatTag, type: 'message' },
    });

    await driver.deliver(message('first'));
    await driver.deliver(message('second'));

    const asked = await expectEventually(
        () => driver.shown(chatTag),
        (list) => list.length === 2,
        { message: 'the worker showed both messages under one tag' },
    );

    expect(asked.map((item) => item.options.body)).toEqual(['first', 'second']);
    expect(asked[1]).toMatchObject({
        title: 'New message from Max',
        options: {
            tag: chatTag,
            renotify: true,
            requireInteraction: false,
            data: { url: `/inbox/${ulid}`, tag: chatTag, type: 'message' },
        },
    });
});

test('a silent dismiss closes the notification with its tag and leaves nothing behind (the transient one it shows for the browser is gone at once)', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { driver, ulid } = await withWorker({ actors, adminApi, instance });

    await driver.record();

    // (A browser display wiped by anything else closing a browser context on this machine: the attempt is run again, `surviveWipes`.)
    await surviveWipes(async (attempt) => {
        const first = `${ulid.slice(0, -1)}${attempt}`;
        const second = `01hz8w3q4n5p6r7s8t9v0x1y3${attempt}`;
        const tag = `offer-${first}`;
        const other = `offer-${second}`;
        const mark = await driver.mark();

        await driver.deliver(offer(first));
        await driver.deliver(offer(second));
        await driver.awaitListed([tag, other], mark);

        // Somebody took the first chat: the server sends a silent push of type `dismiss` with that tag (no title, no body).
        await driver.deliver({
            v: 1,
            data: { url: '/inbox', tag, type: 'dismiss' },
        });
        await driver.awaitClosed(tag, mark);
        await driver.awaitListed([other], mark, {
            where: (list) => list.length === 1 && list[0].tag === other,
        });
        expect((await driver.notifications('pne-dismiss')).length).toBe(0);

        // A dismiss for a tag that is not shown (the notification was clicked already) is harmless and shows nothing either.
        const before = await driver.mark();

        await driver.deliver({
            v: 1,
            data: {
                url: '/inbox',
                tag: `offer-gone-${attempt}`,
                type: 'dismiss',
            },
        });
        await expectEventually(
            () => driver.log(before),
            (log) => log.includes('shown pne-dismiss'),
            { message: 'the worker handled the second dismiss' },
        );
        await driver.awaitListed([other], mark, {
            where: (list) => list.length === 1 && list[0].tag === other,
        });
        expect((await driver.notifications('pne-dismiss')).length).toBe(0);
    });
});

test('odd payloads are survived: plain text becomes the title, junk becomes a generic notification, and a foreign or script URL becomes the inbox', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { driver } = await withWorker({ actors, adminApi, instance });

    // None of these is `requireInteraction` (headless Chrome would close them at once): the worker's own calls are recorded.
    await driver.record();

    // Text that is not JSON: shown as the title.
    await driver.deliver('Somebody needs you');
    await expectEventually(
        () => driver.shown(),
        (list) => list.some((item) => item.title === 'Somebody needs you'),
        { message: 'plain text shown' },
    );

    // JSON that is not an object: the generic title, no tag, the inbox.
    await driver.deliver('42');

    const generic = await expectEventually(
        () => driver.shown(),
        (list) => list.some((item) => item.title === 'New notification'),
        { message: 'a generic notification' },
    );
    const junk = generic.find((item) => item.title === 'New notification')!;

    expect(junk.options.tag).toBeUndefined();
    expect(junk.options.data?.url).toBe('/inbox');

    // The URL in the data is only ever a same-origin path: anything else opens the inbox.
    for (const [index, url] of [
        'https://evil.example/steal',
        '//evil.example/steal',
        'javascript:alert(1)',
    ].entries()) {
        const tag = `junk-${index}`;

        await driver.deliver({
            v: 1,
            title: `Link ${index}`,
            body: 'x',
            data: { url, tag, type: 'message' },
        });

        const [asked] = await expectEventually(
            () => driver.shown(tag),
            (list) => list.length === 1,
            { message: `notification for ${url}` },
        );

        expect(asked.options.data?.url).toBe('/inbox');
    }

    // A same-origin path with a query and a hash survives intact.
    await driver.deliver({
        v: 1,
        title: 'Deep link',
        body: 'x',
        data: { url: '/inbox/abc?x=1#top', tag: 'deep', type: 'message' },
    });

    const [deep] = await expectEventually(
        () => driver.shown('deep'),
        (list) => list.length === 1,
        { message: 'deep link shown' },
    );

    expect(deep.options.data?.url).toBe('/inbox/abc?x=1#top');
});

test('a click on a notification brings the dashboard to the chat (the page navigates itself, no reload) and a foreign URL opens the inbox; a worker with no dashboard window opens one', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann, driver } = await withWorker({
        actors,
        adminApi,
        instance,
    });
    const worker = await driver.worker();

    // What a browser only allows for a real click is recorded instead (focusing a window, opening one); everything else is the worker's own.
    const click = (url: string) =>
        worker.evaluate(async (target) => {
            const calls: { focus: number; opened: string[]; closed: number } = {
                focus: 0,
                opened: [],
                closed: 0,
            };
            const scope = self as unknown as {
                clients: { openWindow: (url: string) => Promise<unknown> };
            };

            (
                self as unknown as {
                    WindowClient: {
                        prototype: { focus: () => Promise<unknown> };
                    };
                }
            ).WindowClient.prototype.focus = async function (this: unknown) {
                calls.focus += 1;

                return this;
            };
            scope.clients.openWindow = async (opened: string) => {
                calls.opened.push(opened);

                return null;
            };

            const waits: Promise<unknown>[] = [];
            const event = new Event('notificationclick') as Event & {
                notification: unknown;
                waitUntil: (promise: Promise<unknown>) => void;
            };

            event.notification = {
                data: { url: target },
                close: () => {
                    calls.closed += 1;
                },
            };
            event.waitUntil = (promise) => {
                waits.push(promise);
            };
            self.dispatchEvent(event);
            await Promise.all(waits);

            return calls;
        }, url);

    // The dashboard window is found, focused, and told to go to the page: the page navigates by itself (no reload of the shell).
    const calls = await click('/settings/notifications');

    expect(calls).toEqual({ focus: 1, opened: [], closed: 1 });
    await expect(ann.page).toHaveURL(/\/settings\/notifications$/);

    // A foreign URL in the notification is turned into the inbox by the worker before the page ever sees it.
    await click('https://evil.example/phish');
    await expect(ann.page).toHaveURL(/\/inbox$/);

    // The page itself refuses what is not a same-origin path, whoever posts it (a message that did not come from this worker's own checks).
    await ann.page.evaluate(() => {
        navigator.serviceWorker.dispatchEvent(
            new MessageEvent('message', {
                data: { type: 'pne:open', url: 'https://evil.example/phish' },
            }),
        );
        navigator.serviceWorker.dispatchEvent(
            new MessageEvent('message', {
                data: { type: 'pne:open', url: '//evil.example/phish' },
            }),
        );
    });
    await expect(ann.page).toHaveURL(/\/inbox$/);

    // Only the visitor's chat page is open (not a dashboard window): there is nobody to focus, so a new window is opened at the path.
    const key = readSeed(instance).widget.key;

    await ann.page.goto(`/embed/${key}`);
    await expect(ann.page).toHaveURL(new RegExp(`/embed/${key}`));

    const lonely = await click('/settings/notifications');

    expect(lonely.focus).toBe(0);
    expect(lonely.opened).toEqual(['/settings/notifications']);
});

test('a rotated subscription is registered again by the worker itself (session cookie and XSRF token), and the open dashboard is told to re-check', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann, driver, subscription } = await withWorker({
        actors,
        adminApi,
        instance,
    });
    const worker = await driver.worker();
    const replacement = FakeSubscription.dead();

    await expectEventually(
        () => pushDevices(ann),
        (devices) => devices.length === 1,
        { timeout: 45_000, message: 'the first registration' },
    );

    // The browser replaced the subscription: the event carries the new one (a stand-in with `toJSON`, like the real PushSubscription).
    await worker.evaluate(async (json) => {
        const waits: Promise<unknown>[] = [];
        const event = new Event('pushsubscriptionchange') as Event & {
            newSubscription: unknown;
            waitUntil: (promise: Promise<unknown>) => void;
        };

        event.newSubscription = { toJSON: () => json };
        event.waitUntil = (promise) => {
            waits.push(promise);
        };
        self.dispatchEvent(event);
        await Promise.all(waits);
    }, replacement.toJSON());

    // The worker's own POST reached the server as the signed-in member: two browsers now (the page re-checks and keeps its own as well).
    const devices = await expectEventually(
        () => pushDevices(ann),
        (list) =>
            list.some(
                (device) =>
                    device.endpointHash === endpointHash(replacement.endpoint),
            ),
        {
            timeout: 45_000,
            message: 'the replacement was registered by the worker',
        },
    );

    expect(devices.map((device) => device.endpointHash)).toContain(
        endpointHash(subscription.endpoint),
    );
});

test('where `new Notification()` is not allowed (Chrome on Android) the page shows its notification through the worker, with the same tag and the path to open', async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);

    await ann.context.grantPermissions(['notifications'], {
        origin: instance.url,
    });
    await prepareBrowser(ann, {
        permission: 'real',
        subscription: FakeSubscription.dead(),
        visibility: true,
    });
    // Android Chrome throws "Illegal constructor" for `new Notification()`: reproduce exactly that, keep everything else real.
    await ann.context.addInitScript(() => {
        const Native = window.Notification;

        window.Notification = new Proxy(Native, {
            construct() {
                throw new TypeError(
                    "Failed to construct 'Notification': Illegal constructor.",
                );
            },
        });
    });
    await ann.inbox.goto();
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    // The server has it (the next steps age its record, and a reload would cancel a request still on its way).
    await expect
        .poll(
            async () =>
                ((await ann.api.presence()).data as { status: string }).status,
        )
        .toBe('online');

    const driver = await ServiceWorkerDriver.attach(ann.page, instance);

    await driver.ready();
    // The PAGE asks the registration to show it (no code of the worker runs), and headless Chrome closes a notification that is not
    // `requireInteraction` at once: the page's own call is what is checked.
    await ann.page.evaluate(() => {
        const calls: { title: string; options: Record<string, unknown> }[] = [];
        const proto = ServiceWorkerRegistration.prototype;
        const original = Reflect.get(proto, 'showNotification') as (
            this: ServiceWorkerRegistration,
            title: string,
            options?: NotificationOptions,
        ) => Promise<void>;

        (
            window as unknown as { __registrationShown: typeof calls }
        ).__registrationShown = calls;
        ServiceWorkerRegistration.prototype.showNotification = function (
            title,
            options,
        ) {
            calls.push({
                title,
                options: JSON.parse(JSON.stringify(options ?? {})),
            });

            return original.call(this, title, options);
        };
    });
    await setVisibility(ann.page, 'hidden');

    const { VisitorApi } = await import('../support/chat-api');
    const visitor = await VisitorApi.start(rig.instance, {
        key: world.widget.key,
    });
    const { ulid } = must<{ ulid: string }>(
        await visitor.startChat({
            category: world.categories.main.slug,
            name: 'Android Andy',
        }),
        'a chat starts',
    );

    const [shown] = await expectEventually(
        () =>
            ann.page.evaluate(
                (tag) =>
                    (
                        window as unknown as {
                            __registrationShown: {
                                title: string;
                                options: Record<string, any>;
                            }[];
                        }
                    ).__registrationShown.filter(
                        (call) => call.options.tag === tag,
                    ),
                `offer-${ulid}`,
            ),
        (list) => list.length === 1,
        { message: 'the page asked the registration to show its notification' },
    );

    expect(shown.title).toBe('New chat request');
    expect(shown.options.body).toContain('Android Andy');
    expect(shown.options.icon).toBe('/icons/icon-192.png');
    expect(shown.options.data).toEqual({
        url: `/inbox/${ulid}`,
        tag: `offer-${ulid}`,
        type: 'offer',
    });

    await visitor.dispose();
});
