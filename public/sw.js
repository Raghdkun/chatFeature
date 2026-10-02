/*
 * PNE Chat service worker: web push for the staff dashboard, nothing else (docs/notifications.md, decision P5-D6).
 *
 * Plain JavaScript, served as-is from /sw.js with scope "/": no build step, no caching, no fetch handler (it never sits between the
 * page and the network). It handles three events:
 *
 *  - push                    show the notification the server sent (tag/renotify), or, for a silent `dismiss`, close the
 *                            notification with that tag.
 *  - notificationclick       focus a dashboard tab that is already open and tell it where to go; open a new one otherwise.
 *  - pushsubscriptionchange  the browser replaced the subscription: subscribe again and register the new one.
 *
 * The payload (JSON, end-to-end encrypted by the push protocol): { v, title, body, renotify, requireInteraction, data: { url, tag, type } }
 * with type one of offer | message | test | dismiss. A dismiss carries no text.
 */
'use strict';

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';
const DEFAULT_URL = '/inbox';
const SUBSCRIPTIONS_URL = '/api/v1/me/push-subscriptions';
/* Pages that are ours but not the dashboard: a visitor's chat (embedded or hosted) and the installer must never be navigated away. */
const NOT_DASHBOARD = ['/embed/', '/c/', '/w/', '/widget/', '/setup'];
const TRANSIENT_TAG = 'pne-dismiss';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    event.waitUntil(handlePush(event));
});

self.addEventListener('notificationclick', (event) => {
    const data = (event.notification && event.notification.data) || {};

    event.notification.close();
    event.waitUntil(openDashboard(safePath(data.url)));
});

self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(resubscribe(event));
});

function readPayload(event) {
    if (!event.data) {
        return {};
    }

    try {
        const parsed = event.data.json();

        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        try {
            return { title: event.data.text() };
        } catch (ignored) {
            return {};
        }
    }
}

async function handlePush(event) {
    const payload = readPayload(event);
    const data =
        payload.data && typeof payload.data === 'object' ? payload.data : {};

    if (data.type === 'dismiss') {
        return dismiss(typeof data.tag === 'string' ? data.tag : '');
    }

    return show(payload, data);
}

function show(payload, data) {
    const tag =
        typeof data.tag === 'string' && data.tag !== '' ? data.tag : undefined;
    const title =
        typeof payload.title === 'string' && payload.title !== ''
            ? payload.title
            : 'New notification';
    const options = {
        body: typeof payload.body === 'string' ? payload.body : '',
        icon: ICON,
        badge: BADGE,
        requireInteraction: payload.requireInteraction === true,
        data: {
            url: safePath(data.url),
            tag: tag,
            type: typeof data.type === 'string' ? data.type : 'message',
        },
    };

    // `renotify` is only valid together with a tag (the browser throws without one).
    if (tag !== undefined) {
        options.tag = tag;
        options.renotify = payload.renotify === true;
    }

    return self.registration.showNotification(title, options);
}

/*
 * The silent push: close what the tag names. Browsers insist that every push ends in a visible notification (Chrome shows a generic
 * "updated in the background" one, Safari drops the subscription after a few violations), so a dismissal that shows nothing would
 * cost more than it gains: a notification is shown and taken down again at once (silent, no sound). The server only sends a dismiss
 * to devices it pushed the notification to, so this is the rare path.
 */
async function dismiss(tag) {
    if (tag !== '') {
        const open = await self.registration.getNotifications({ tag: tag });

        open.forEach((notification) => notification.close());
    }

    await self.registration.showNotification(
        self.location.hostname || 'PNE Chat',
        {
            tag: TRANSIENT_TAG,
            silent: true,
            icon: ICON,
            badge: BADGE,
        },
    );

    const transient = await self.registration.getNotifications({
        tag: TRANSIENT_TAG,
    });

    transient.forEach((notification) => notification.close());
}

/* A same-origin path (with query and hash) from whatever the payload says; anything else is the inbox. */
function safePath(raw) {
    if (typeof raw !== 'string' || raw === '') {
        return DEFAULT_URL;
    }

    try {
        const url = new URL(raw, self.location.origin);

        return url.origin === self.location.origin
            ? url.pathname + url.search + url.hash
            : DEFAULT_URL;
    } catch (error) {
        return DEFAULT_URL;
    }
}

function isDashboardWindow(client) {
    try {
        const url = new URL(client.url);

        return (
            url.origin === self.location.origin &&
            !NOT_DASHBOARD.some((prefix) => url.pathname.startsWith(prefix))
        );
    } catch (error) {
        return false;
    }
}

async function openDashboard(path) {
    const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
    });
    const dashboards = windows.filter(isDashboardWindow);
    // The one the person is most likely looking at: focused, else visible, else any.
    const target =
        dashboards.find((client) => client.focused) ||
        dashboards.find((client) => client.visibilityState === 'visible') ||
        dashboards[0];

    if (target) {
        try {
            const focused = await target.focus();

            // The page navigates itself (no reload, the live inbox keeps its state).
            (focused || target).postMessage({ type: 'pne:open', url: path });

            return;
        } catch (error) {
            // A window that cannot be focused: fall through to a new one.
        }
    }

    await self.clients.openWindow(path);
}

async function cookie(name) {
    try {
        const entry = self.cookieStore
            ? await self.cookieStore.get(name)
            : null;

        return entry ? entry.value : null;
    } catch (error) {
        return null;
    }
}

/* Best effort: when the browser rotates the subscription, subscribe again with the same server key and register it. Open pages are told
   either way, and every page load re-checks the registration itself (so a missed one is repaired the next time the dashboard opens). */
async function resubscribe(event) {
    let subscription = event.newSubscription || null;

    try {
        const key =
            event.oldSubscription &&
            event.oldSubscription.options &&
            event.oldSubscription.options.applicationServerKey;

        if (!subscription && key) {
            subscription = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key,
            });
        }

        if (subscription) {
            const xsrf = await cookie('XSRF-TOKEN');
            const headers = {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            };

            if (xsrf) {
                headers['X-XSRF-TOKEN'] = xsrf;
            }

            await fetch(SUBSCRIPTIONS_URL, {
                method: 'POST',
                headers: headers,
                credentials: 'same-origin',
                body: JSON.stringify(subscription.toJSON()),
            });
        }
    } catch (error) {
        // The page repairs it on its next load.
    }

    const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
    });

    windows.forEach((client) =>
        client.postMessage({ type: 'pne:subscription-changed' }),
    );
}
