/**
 * The one place the inbox touches the browser's `Notification` API for notifications the PAGE shows (the server's web push is shown
 * by the service worker, `public/sw.js`). It never asks for permission (the opt-in flow lives in `lib/notifications`): it only shows a
 * notification when permission is already granted, and only while the page is NOT in front (the in-app toast and sound cover the
 * focused case; decision P5-D8) and the member is outside their quiet hours.
 *
 * The notification carries the SAME tag as the server's push for the same event (`offer-{ulid}`, `chat-{ulid}`), so the browser
 * replaces one with the other instead of showing both. The inbox's own tag for a message (`message-{ulid}`) is mapped to the
 * server's (`chat-{ulid}`) here, in one place.
 *
 * Where `new Notification()` is not allowed (Chrome on Android throws "Illegal constructor": only a service worker may show
 * notifications there) the same notification is shown through the worker's registration; its click is then handled by the worker,
 * which focuses a dashboard tab and tells it to open `data.url`.
 */

export type OsNotificationOptions = {
    title: string;
    body?: string;
    /** Same tag = replaces the previous notification; also the key for `closeOsNotification`. */
    tag: string;
    onClick?: () => void;
};

type NotificationLike = {
    close: () => void;
    onclick: ((event: Event) => void) | null;
};

type NotificationCtor = {
    new (
        title: string,
        options?: { body?: string; tag?: string },
    ): NotificationLike;
    permission: NotificationPermission;
};

/** The slice of `ServiceWorkerRegistration` this file uses. */
type RegistrationLike = {
    showNotification: (
        title: string,
        options?: {
            body?: string;
            tag?: string;
            icon?: string;
            badge?: string;
            data?: unknown;
        },
    ) => Promise<void>;
    getNotifications: (filter?: {
        tag?: string;
    }) => Promise<{ close: () => void }[]>;
};

export type OsNotificationEnv = {
    Notification: NotificationCtor | undefined;
    pageInFront: () => boolean;
    focusWindow: () => void;
    /** True during the member's quiet hours: no notification from the page either. */
    quiet?: () => boolean;
    /** The active service worker registration, or `null` when there is none. */
    registration?: () => Promise<RegistrationLike | null>;
};

/**
 * What the page-wide environment adds on top of the browser: the notifications controller registers the member's quiet hours here once
 * it has loaded their settings.
 */
const policy: { quiet: (() => boolean) | null } = { quiet: null };

export function setOsNotificationPolicy(next: {
    quiet: (() => boolean) | null;
}): void {
    policy.quiet = next.quiet;
}

/** The inbox's tag for a message notification is the server's push tag for the same chat. */
export function notificationTag(tag: string): string {
    return tag.replace(/^message-/, 'chat-');
}

/** The dashboard path a tag stands for: its chat, else the inbox. */
export function notificationPath(tag: string): string {
    const match = /^(?:offer|chat|message)-([0-9A-Za-z]{26})$/.exec(tag);

    return match ? `/inbox/${match[1]}` : '/inbox';
}

function defaultRegistration(): Promise<RegistrationLike | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return Promise.resolve(null);
    }

    return navigator.serviceWorker
        .getRegistration('/')
        .then((registration) => (registration?.active ? registration : null))
        .catch(() => null);
}

function defaultEnv(): OsNotificationEnv {
    return {
        Notification:
            typeof Notification === 'undefined'
                ? undefined
                : (Notification as unknown as NotificationCtor),
        pageInFront: () =>
            document.visibilityState === 'visible' && document.hasFocus(),
        focusWindow: () => window.focus(),
        quiet: () => policy.quiet?.() ?? false,
        registration: defaultRegistration,
    };
}

const open = new Map<string, NotificationLike>();

/** Show it when permission is already granted, the page is in the background and it is not quiet time; returns whether one was shown. */
export function showOsNotification(
    options: OsNotificationOptions,
    env: OsNotificationEnv = defaultEnv(),
): boolean {
    const Ctor = env.Notification;

    if (
        !Ctor ||
        Ctor.permission !== 'granted' ||
        env.pageInFront() ||
        env.quiet?.() === true
    ) {
        return false;
    }

    const tag = notificationTag(options.tag);

    try {
        open.get(tag)?.close();

        const notification = new Ctor(options.title, {
            body: options.body,
            tag,
        });

        notification.onclick = () => {
            env.focusWindow();
            options.onClick?.();
            notification.close();
        };
        open.set(tag, notification);

        return true;
    } catch {
        // `new Notification()` is not allowed here (Android): the worker shows it.
        void showThroughWorker(options, tag, env);

        return env.registration !== undefined;
    }
}

async function showThroughWorker(
    options: OsNotificationOptions,
    tag: string,
    env: OsNotificationEnv,
): Promise<void> {
    try {
        const registration = await env.registration?.();

        await registration?.showNotification(options.title, {
            body: options.body,
            tag,
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            data: { url: notificationPath(tag), tag },
        });
    } catch {
        // Nothing more to try: the in-app toast and sound already announced it.
    }
}

/** Dismiss a notification (an offer another agent took), wherever it was shown from. */
export function closeOsNotification(
    tag: string,
    env: Pick<OsNotificationEnv, 'registration'> = defaultEnv(),
): void {
    const key = notificationTag(tag);

    open.get(key)?.close();
    open.delete(key);

    void env
        .registration?.()
        .then((registration) => registration?.getNotifications({ tag: key }))
        .then((shown) => shown?.forEach((notification) => notification.close()))
        .catch(() => undefined);
}
