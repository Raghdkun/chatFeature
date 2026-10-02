/**
 * The browser side of web push behind one small interface (`PushEnv`), so the controller is plain logic that tests drive with a fake:
 * the service worker registration, the push subscription, the permission prompt and the messages the worker posts to the page.
 */
import { notificationRoutes } from '@/lib/notifications/routes';
import { detectPushSupport, readPermission } from '@/lib/notifications/support';
import type { PermissionState, PushSupport } from '@/lib/notifications/types';
import type { PushSubscriptionJson } from '@/lib/notifications/api';

/** A push subscription as the controller needs it (the real `PushSubscription` satisfies it). */
export type SubscriptionLike = {
    endpoint: string;
    expirationTime?: number | null;
    options?: { applicationServerKey?: ArrayBuffer | null };
    toJSON: () => PushSubscriptionJson;
    unsubscribe: () => Promise<boolean>;
};

export type PushEnv = {
    support: PushSupport;
    permission: () => PermissionState;
    /** Shows the browser's own prompt. Call it ONLY from the handler of a button the person pressed. */
    requestPermission: () => Promise<NotificationPermission>;
    /** Registers `/sw.js` (scope `/`) and resolves when it is active. */
    registerWorker: () => Promise<void>;
    currentSubscription: () => Promise<SubscriptionLike | null>;
    subscribe: (
        applicationServerKey: Uint8Array<ArrayBuffer>,
    ) => Promise<SubscriptionLike>;
    sha256Hex: (text: string) => Promise<string>;
    /** Messages the service worker posts to the page; returns the unsubscribe. */
    onWorkerMessage: (handler: (data: unknown) => void) => () => void;
};

/** The URL-safe base64 of a VAPID public key as the bytes `pushManager.subscribe` wants. */
export function applicationServerKey(
    base64Url: string,
): Uint8Array<ArrayBuffer> {
    const padded = base64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
    const raw = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));

    for (let index = 0; index < raw.length; index++) {
        bytes[index] = raw.charCodeAt(index);
    }

    return bytes;
}

/** Whether a subscription was made with this key (a rotated VAPID key means the browser must subscribe again). */
export function sameApplicationServerKey(
    existing: ArrayBuffer | null | undefined,
    wanted: Uint8Array,
): boolean {
    if (!existing) {
        return false;
    }

    const bytes = new Uint8Array(existing);

    return (
        bytes.length === wanted.length &&
        bytes.every((value, index) => value === wanted[index])
    );
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text),
    );

    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
}

/** `Notification.requestPermission()` returns a promise in every current browser; very old Safari takes a callback. */
function askPermission(): Promise<NotificationPermission> {
    return new Promise((resolve, reject) => {
        try {
            const result = Notification.requestPermission((answer) =>
                resolve(answer),
            );

            if (result && typeof result.then === 'function') {
                void result.then(resolve, reject);
            }
        } catch (error) {
            reject(error);
        }
    });
}

export function browserPushEnv(): PushEnv {
    const support = detectPushSupport();
    const ready = (): Promise<ServiceWorkerRegistration> =>
        navigator.serviceWorker.ready;

    return {
        support,
        permission: readPermission,
        requestPermission: askPermission,
        async registerWorker() {
            await navigator.serviceWorker.register(notificationRoutes.worker, {
                scope: '/',
                updateViaCache: 'none',
            });
            await ready();
        },
        async currentSubscription() {
            return (await ready()).pushManager.getSubscription();
        },
        async subscribe(key) {
            return (await ready()).pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key,
            });
        },
        sha256Hex,
        onWorkerMessage(handler) {
            if (!('serviceWorker' in navigator)) {
                return () => undefined;
            }

            const listener = (event: MessageEvent): void => handler(event.data);

            navigator.serviceWorker.addEventListener('message', listener);

            return () =>
                navigator.serviceWorker.removeEventListener(
                    'message',
                    listener,
                );
        },
    };
}
