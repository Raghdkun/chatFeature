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

/**
 * The shared Inertia prop `realtime` (`HandleInertiaRequests`): where Reverb lives, read from the server's own settings at runtime.
 * `null` is the server's answer "realtime is off here" (not configured, or this account has no chat role); `undefined` means the
 * server did not say anything at all (the prop is absent: an older server).
 */
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
 * Where the websocket connects. The server's answer wins: the shared prop names the address (no rebuild needed when it changes), and
 * `null` means "off", so the dashboard polls over REST without a single connection attempt, whatever this build was compiled with.
 * Only a prop that is entirely ABSENT (an older server) leaves the `VITE_REVERB_*` values baked into this build, and without them
 * there is nowhere to connect either (`null`). The values are never logged.
 */
export function reverbSettings(
    prop?: RealtimeProp,
    env: Record<string, unknown> = import.meta.env,
): ReverbSettings | null {
    if (prop === null) {
        return null;
    }

    if (prop !== undefined) {
        return text(prop.key) !== '' &&
            text(prop.host) !== '' &&
            Number.isInteger(prop.port) &&
            prop.port > 0
            ? {
                  key: text(prop.key),
                  host: text(prop.host),
                  port: prop.port,
                  forceTLS: prop.scheme === 'https',
              }
            : null;
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
    prop?: RealtimeProp,
): boolean {
    return reverbSettings(prop, env) !== null;
}

/**
 * The `configureEcho` options: the Reverb address (when known) and the channel authorisation. Without an address the library would
 * fall back to the build's own `VITE_REVERB_*` values, so nothing may ask it for a connection then: the host mounts no Echo binding
 * while `socketsConfigured()` is false.
 */
export function staffEchoOptions(
    prop?: RealtimeProp,
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
