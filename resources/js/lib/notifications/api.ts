/**
 * Typed client of the notification endpoints (docs/rest-api.md, "Notifications"): session cookie + `X-XSRF-TOKEN`, the `{ data }` /
 * `{ error }` envelopes come from the shared api client. Bodies are snake_case on the wire, the shapes the UI uses are camelCase.
 */
import { api, type ApiClient } from '@/lib/api-client';
import { notificationRoutes } from '@/lib/notifications/routes';
import type {
    NotificationSettings,
    NotificationSettingsPatch,
    PushDevice,
    PushTestResult,
} from '@/lib/notifications/types';

/** What `PushSubscription.toJSON()` gives, which is also exactly the body `POST /me/push-subscriptions` takes. */
export type PushSubscriptionJson = {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: { p256dh?: string; auth?: string };
};

/** The wire body of `PUT /me/notification-settings`: only what was given. */
export function settingsBody(patch: NotificationSettingsPatch): {
    sound?: boolean;
    push_offers?: boolean;
    push_messages?: boolean;
    include_preview?: boolean;
    quiet_hours?: {
        enabled?: boolean;
        start?: string;
        end?: string;
        timezone?: string;
    };
    prompt_state?: string;
} {
    const body: ReturnType<typeof settingsBody> = {};

    if (patch.sound !== undefined) {
        body.sound = patch.sound;
    }

    if (patch.pushOffers !== undefined) {
        body.push_offers = patch.pushOffers;
    }

    if (patch.pushMessages !== undefined) {
        body.push_messages = patch.pushMessages;
    }

    if (patch.includePreview !== undefined) {
        body.include_preview = patch.includePreview;
    }

    if (patch.quietHours !== undefined) {
        body.quiet_hours = {
            ...(patch.quietHours.enabled !== undefined
                ? { enabled: patch.quietHours.enabled }
                : {}),
            ...(patch.quietHours.start !== undefined
                ? { start: patch.quietHours.start }
                : {}),
            ...(patch.quietHours.end !== undefined
                ? { end: patch.quietHours.end }
                : {}),
            ...(patch.quietHours.timezone !== undefined
                ? { timezone: patch.quietHours.timezone }
                : {}),
        };
    }

    if (patch.promptState !== undefined) {
        body.prompt_state = patch.promptState;
    }

    return body;
}

export function createNotificationsApi(client: ApiClient = api) {
    return {
        settings: () =>
            client.get<NotificationSettings>(notificationRoutes.api.settings),

        updateSettings: (patch: NotificationSettingsPatch) =>
            client.put<NotificationSettings>(
                notificationRoutes.api.settings,
                settingsBody(patch),
            ),

        devices: () =>
            client.get<PushDevice[]>(notificationRoutes.api.subscriptions),

        /** An upsert by endpoint: the same browser registering again refreshes its row. */
        register: (subscription: PushSubscriptionJson) =>
            client.post<PushDevice>(
                notificationRoutes.api.subscriptions,
                subscription,
            ),

        remove: (id: string) =>
            client.delete(notificationRoutes.api.subscription(id)),

        /** A real push to the caller's own browsers, sent right away: the answer says what the push services did. */
        test: () => client.post<PushTestResult>(notificationRoutes.api.test),
    };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;

/** The client the dashboard uses (it resolves `fetch` lazily, so tests stub the global). */
export const notificationsApi: NotificationsApi = createNotificationsApi();
