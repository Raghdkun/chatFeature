import { readXsrfToken } from '@/lib/api-client';
import { staffRoutes } from '@/lib/chat-api/staff';

/**
 * How Echo (Pusher protocol) authorises the staff channels: a POST to Laravel's `/broadcasting/auth` with the session cookie
 * and the CURRENT `X-XSRF-TOKEN` (read per request, so a rotated cookie never leaves the socket unable to subscribe). The root
 * view has no `csrf-token` meta tag, which is what Echo would otherwise look for.
 */
export function staffChannelAuthorization(
    xsrfToken: () => string | null = () => readXsrfToken(),
) {
    return {
        transport: 'ajax' as const,
        endpoint: staffRoutes.broadcastingAuth(),
        headersProvider: (): Record<string, string> => {
            const token = xsrfToken();

            return {
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                ...(token ? { 'X-XSRF-TOKEN': token } : {}),
            };
        },
    };
}

/** Whether this build has the Reverb settings the websocket needs (`VITE_REVERB_*`); without them the dashboard polls over REST. */
export function socketsConfigured(
    env: Record<string, unknown> = import.meta.env,
): boolean {
    return Boolean(env.VITE_REVERB_APP_KEY);
}
