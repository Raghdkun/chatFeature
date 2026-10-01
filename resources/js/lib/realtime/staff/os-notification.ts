/**
 * The one place the inbox touches the browser's `Notification` API. P4 never asks for permission (the opt-in flow and web push
 * belong to P5): it only shows a notification when the agent has already granted it, and only while the page is not in front
 * (the in-app toast covers the focused case). P5 extends this wrapper (push, permission prompt) without touching the callers.
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

export type OsNotificationEnv = {
    Notification: NotificationCtor | undefined;
    pageInFront: () => boolean;
    focusWindow: () => void;
};

function defaultEnv(): OsNotificationEnv {
    return {
        Notification:
            typeof Notification === 'undefined'
                ? undefined
                : (Notification as unknown as NotificationCtor),
        pageInFront: () =>
            document.visibilityState === 'visible' && document.hasFocus(),
        focusWindow: () => window.focus(),
    };
}

const open = new Map<string, NotificationLike>();

/** Show it when permission is already granted and the page is in the background; returns whether one was shown. */
export function showOsNotification(
    options: OsNotificationOptions,
    env: OsNotificationEnv = defaultEnv(),
): boolean {
    const Ctor = env.Notification;

    if (!Ctor || Ctor.permission !== 'granted' || env.pageInFront()) {
        return false;
    }

    try {
        open.get(options.tag)?.close();

        const notification = new Ctor(options.title, {
            body: options.body,
            tag: options.tag,
        });

        notification.onclick = () => {
            env.focusWindow();
            options.onClick?.();
            notification.close();
        };
        open.set(options.tag, notification);

        return true;
    } catch {
        return false;
    }
}

/** Dismiss a notification (an offer another agent took). */
export function closeOsNotification(tag: string): void {
    open.get(tag)?.close();
    open.delete(tag);
}
