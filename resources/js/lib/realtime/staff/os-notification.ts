/**
 * The one place the inbox touches the browser's `Notification` API for notifications the PAGE shows (the server's web push is shown
 * by the service worker, `public/sw.js`). It never asks for permission (the opt-in flow lives in `lib/notifications`): it only shows a
 * notification when permission is already granted, the page is NOT in front (the in-app toast and sound cover the focused case;
 * decision P5-D8), the member is outside their quiet hours and their own preferences allow it:
 *
 *  - "Turn off for this browser" silences it here too;
 *  - "New chat requests" (`push_offers`) and "New messages" (`push_messages`) govern the page's notifications as they govern the push;
 *  - the visitor's name and words appear only when BOTH the administrator's preview switch and the member's own one are on; otherwise
 *    the caller's `generic` text is shown (the same wording the server's push uses). Until the member's settings have loaded the
 *    answer is "no visitor text".
 *
 * Where it is shown from: through the service worker's registration whenever a worker is active (the worker is also what shows the
 * server's push, so a notification of the page and the push of the same event share one notification list and the same tag replaces
 * rather than doubles; Chrome on Android only allows it this way anyway). Its click is handled by the worker, which focuses a dashboard
 * tab and tells it to open `data.url`. Without a worker, `new Notification()` is the fallback (closed again by tag).
 *
 * The tag is the SAME as the server's push for the same event (`offer-{ulid}`, `chat-{ulid}`). The inbox's own tag for a message
 * (`message-{ulid}`) is mapped to the server's (`chat-{ulid}`) here, in one place.
 */

export type OsNotificationKind = 'offer' | 'message';

export type OsNotificationOptions = {
    title: string;
    body?: string;
    /** Same tag = replaces the previous notification; also the key for `closeOsNotification`. */
    tag: string;
    /** Which of the member's switches governs it. Default: read from the tag (`offer-` is an offer, anything else a message). */
    kind?: OsNotificationKind;
    /** What it says when visitor text may not be shown: no name, no words. Without it a private notification only has the title. */
    generic?: { title: string; body?: string };
    /** Only for the `new Notification()` fallback: a worker-shown notification is clicked inside the worker. */
    onClick?: () => void;
};

/** What the member (and the administrator) allow the page to show. */
export type OsPreferences = {
    /** The visitor's name and words may appear (the administrator's switch AND the member's own). */
    previews: boolean;
    /** "New chat requests". */
    offers: boolean;
    /** "New messages". */
    messages: boolean;
    /** "Turn off for this browser". */
    off: boolean;
};

type NotificationLike = {
    close: () => void;
    onclick: ((event: Event) => void) | null;
    onclose?: ((event: Event) => void) | null;
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
            renotify?: boolean;
            requireInteraction?: boolean;
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
    /** The member's preferences; absent = everything allowed (a test double that does not care). */
    preferences?: () => OsPreferences;
    /** The active service worker registration, or `null` when there is none. */
    registration?: () => Promise<RegistrationLike | null>;
};

const ALLOW_ALL: OsPreferences = {
    previews: true,
    offers: true,
    messages: true,
    off: false,
};

/** Before the notifications controller has loaded the member's settings: switches as the server defaults them, but no visitor text. */
const UNKNOWN: OsPreferences = {
    previews: false,
    offers: true,
    messages: true,
    off: false,
};

/**
 * What the page-wide environment adds on top of the browser: the notifications controller registers the member's quiet hours and
 * preferences here (as getters, so they are always current).
 */
const policy: {
    quiet: (() => boolean) | null;
    preferences: (() => OsPreferences) | null;
} = { quiet: null, preferences: null };

export function setOsNotificationPolicy(next: {
    quiet?: (() => boolean) | null;
    preferences?: (() => OsPreferences) | null;
}): void {
    if (next.quiet !== undefined) {
        policy.quiet = next.quiet;
    }

    if (next.preferences !== undefined) {
        policy.preferences = next.preferences;
    }
}

/** Back to "nothing registered" (sign-out, tests). */
export function resetOsNotificationPolicy(): void {
    policy.quiet = null;
    policy.preferences = null;
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

function kindOf(options: OsNotificationOptions): OsNotificationKind {
    return (
        options.kind ?? (options.tag.startsWith('offer-') ? 'offer' : 'message')
    );
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
        preferences: () => policy.preferences?.() ?? UNKNOWN,
        registration: defaultRegistration,
    };
}

/** The page's own `new Notification()` objects, so the next one with the tag (or a dismissal) can close them. */
const open = new Map<string, NotificationLike>();

async function activeRegistration(
    env: Pick<OsNotificationEnv, 'registration'>,
): Promise<RegistrationLike | null> {
    try {
        return (await env.registration?.()) ?? null;
    } catch {
        return null;
    }
}

/**
 * Show it when permission is already granted, the page is in the background, it is not quiet time and the member's preferences allow
 * it. Resolves to whether one was shown.
 */
export async function showOsNotification(
    options: OsNotificationOptions,
    env: OsNotificationEnv = defaultEnv(),
): Promise<boolean> {
    const Ctor = env.Notification;
    const kind = kindOf(options);
    const preferences = env.preferences?.() ?? ALLOW_ALL;

    if (
        !Ctor ||
        Ctor.permission !== 'granted' ||
        env.pageInFront() ||
        env.quiet?.() === true ||
        preferences.off ||
        !(kind === 'offer' ? preferences.offers : preferences.messages)
    ) {
        return false;
    }

    const text = preferences.previews
        ? { title: options.title, body: options.body }
        : (options.generic ?? { title: options.title });
    const tag = notificationTag(options.tag);
    const registration = await activeRegistration(env);

    if (registration) {
        try {
            open.get(tag)?.close();
            open.delete(tag);

            await registration.showNotification(text.title, {
                body: text.body,
                tag,
                icon: '/icons/icon-192.png',
                badge: '/icons/badge-96.png',
                // The same behaviour as the server's push for the event: a chat's next message alerts again, an offer stays until acted on.
                renotify: kind === 'message',
                requireInteraction: kind === 'offer',
                data: { url: notificationPath(tag), tag, type: kind },
            });

            return true;
        } catch {
            // The worker refused: the constructor is the last resort.
        }
    }

    try {
        open.get(tag)?.close();

        const notification = new Ctor(text.title, { body: text.body, tag });
        const forget = (): void => {
            if (open.get(tag) === notification) {
                open.delete(tag);
            }
        };

        notification.onclick = () => {
            env.focusWindow();
            options.onClick?.();
            notification.close();
            forget();
        };
        notification.onclose = forget;
        open.set(tag, notification);

        return true;
    } catch {
        // `new Notification()` is not allowed here and no worker is active: the in-app toast and sound already announced it.
        return false;
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
