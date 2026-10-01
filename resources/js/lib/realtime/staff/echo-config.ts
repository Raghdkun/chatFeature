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

/** The shared Inertia prop `realtime` (`HandleInertiaRequests`): where Reverb lives, read from the server's own settings at runtime. */
export type RealtimeProp =
    | { key: string; host: string; port: number; scheme: string }
    | null
    | undefined;

export type ReverbSettings = {
    key: string;
    host: string;
    port: number;
    forceTLS: boolean;
};

const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

/**
 * Where the websocket connects: the shared prop first (no rebuild needed when the server's address changes), else the `VITE_REVERB_*`
 * values baked into this build, else nowhere (`null`: the dashboard polls over REST). The values are never logged.
 */
export function reverbSettings(
    prop: RealtimeProp = null,
    env: Record<string, unknown> = import.meta.env,
): ReverbSettings | null {
    if (
        prop !== null &&
        prop !== undefined &&
        text(prop.key) !== '' &&
        text(prop.host) !== '' &&
        Number.isInteger(prop.port) &&
        prop.port > 0
    ) {
        return {
            key: text(prop.key),
            host: text(prop.host),
            port: prop.port,
            forceTLS: prop.scheme === 'https',
        };
    }

    if (text(env.VITE_REVERB_APP_KEY) === '') {
        return null;
    }

    const port = Number(env.VITE_REVERB_PORT);

    return {
        key: text(env.VITE_REVERB_APP_KEY),
        host: text(env.VITE_REVERB_HOST),
        port: Number.isInteger(port) && port > 0 ? port : 443,
        forceTLS: (text(env.VITE_REVERB_SCHEME) || 'https') === 'https',
    };
}

/** Whether a websocket can be opened at all, from either source; without one the dashboard polls over REST. */
export function socketsConfigured(
    env: Record<string, unknown> = import.meta.env,
    prop: RealtimeProp = null,
): boolean {
    return reverbSettings(prop, env) !== null;
}

/**
 * The `configureEcho` options: the Reverb address (when known; otherwise the library's `VITE_REVERB_*` defaults apply and nothing
 * connects) and the channel authorisation.
 */
export function staffEchoOptions(
    prop: RealtimeProp = null,
    env: Record<string, unknown> = import.meta.env,
    xsrfToken?: () => string | null,
) {
    const reverb = reverbSettings(prop, env);

    return {
        broadcaster: 'reverb' as const,
        ...(reverb === null
            ? {}
            : {
                  key: reverb.key,
                  wsHost: reverb.host,
                  wsPort: reverb.port,
                  wssPort: reverb.port,
                  forceTLS: reverb.forceTLS,
                  enabledTransports: ['ws', 'wss'] as ('ws' | 'wss')[],
              }),
        // The root view has no csrf-token meta tag: send the XSRF cookie value with the channel auth request instead.
        channelAuthorization: staffChannelAuthorization(xsrfToken),
    };
}
