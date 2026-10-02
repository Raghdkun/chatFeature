/** Every URL of the notification client, in one place (Wayfinder output is git-ignored, so these are plain strings pinned by a test). */
const API = '/api/v1';
const enc = encodeURIComponent;

export const notificationRoutes = {
    pages: {
        /** GET /settings/notifications (Inertia `settings/notifications`). */
        settings: '/settings/notifications',
    },
    api: {
        settings: `${API}/me/notification-settings`,
        subscriptions: `${API}/me/push-subscriptions`,
        subscription: (id: string): string =>
            `${API}/me/push-subscriptions/${enc(id)}`,
        test: `${API}/me/push-subscriptions/test`,
    },
    /** The service worker (scope `/`) and the manifest. */
    worker: '/sw.js',
    manifest: '/manifest.webmanifest',
} as const;
