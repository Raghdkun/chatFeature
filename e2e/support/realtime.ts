/**
 * Realtime plumbing of the P4 specs.
 *
 * The VISITOR panel connects to the instance's Reverb directly: the address comes from the `ws` block of its session (the
 * scenario's `REVERB_HOST/PORT`), so those are real sockets end to end.
 *
 * The STAFF dashboard cannot: its Echo reads `VITE_REVERB_*` at BUILD time, and one build serves every scenario while every
 * scenario has a Reverb of its own (and user ids repeat across scenarios, so one shared Reverb would mix their `staff.{id}` channels).
 * `globalSetup` therefore builds the dashboard with the fixed address `DASHBOARD_REVERB` (nothing listens there) and
 * `relayStaffSockets()` forwards every socket a browser context opens to it to the instance's own Reverb: same bytes, same handshake
 * (with the `Origin` of the dashboard, so Reverb's origin check runs for real), only the destination differs.
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { DASHBOARD_REVERB, type Instance } from './scenarios';

/** What a Node `WebSocket` (undici) offers that the DOM typings do not know: request headers on the handshake. */
type UpstreamSocket = WebSocket & { binaryType: 'arraybuffer' | 'blob' };

type NodeWebSocketConstructor = new (
    url: string,
    options: { headers: Record<string, string> },
) => UpstreamSocket;

/** Close codes a page may use (1000 and 3000-4999); anything else (1006 ...) is a plain close. */
const closeCode = (code: number | undefined): number | undefined =>
    code !== undefined && (code === 1000 || (code >= 3000 && code <= 4999))
        ? code
        : undefined;

function relay(
    route: WebSocketRoute,
    instance: Instance,
    upstreams: Set<UpstreamSocket>,
): void {
    const reverb = instance.reverb;

    if (reverb === null) {
        void route.close({ code: 1011, reason: 'no Reverb in this scenario' });

        return;
    }

    const original = new URL(route.url());
    const Socket = WebSocket as unknown as NodeWebSocketConstructor;
    const upstream = new Socket(
        `ws://127.0.0.1:${reverb.port}${original.pathname}${original.search}`,
        // The dashboard's own origin: Reverb accepts sockets from the app's host only.
        { headers: { Origin: instance.url } },
    );
    const waiting: (string | Buffer)[] = [];
    let open = false;

    upstream.binaryType = 'arraybuffer';
    upstreams.add(upstream);

    upstream.addEventListener('open', () => {
        open = true;

        for (const message of waiting.splice(0)) {
            upstream.send(message);
        }
    });
    upstream.addEventListener('message', (event) => {
        const data = event.data as string | ArrayBuffer;

        route.send(typeof data === 'string' ? data : Buffer.from(data));
    });
    upstream.addEventListener('close', (event) => {
        upstreams.delete(upstream);
        void route
            .close({ code: closeCode(event.code), reason: event.reason })
            .catch(() => undefined);
    });
    upstream.addEventListener('error', () => {
        void route
            .close({ code: 1011, reason: 'relay: Reverb is not reachable' })
            .catch(() => undefined);
    });

    route.onMessage((message) => {
        if (open) {
            upstream.send(message);
        } else {
            waiting.push(message);
        }
    });
    route.onClose((code, reason) => {
        upstreams.delete(upstream);

        if (upstream.readyState <= 1) {
            upstream.close(closeCode(code), reason);
        }
    });
}

/**
 * Makes the dashboard pages of a browser context talk to the Reverb of `instance` (see the file comment). Call it once per context
 * that opens staff pages; `test.ts` does it for the `page` / `context` fixtures of a realtime scenario and `actors.staff()` for
 * every actor. A scenario without a Reverb is left alone.
 */
export async function relayStaffSockets(
    context: BrowserContext,
    instance: Instance,
): Promise<void> {
    if (instance.reverb === null) {
        return;
    }

    const upstreams = new Set<UpstreamSocket>();

    await context.routeWebSocket(
        (url) =>
            url.hostname === DASHBOARD_REVERB.host &&
            url.port === String(DASHBOARD_REVERB.port),
        (route) => relay(route, instance, upstreams),
    );
    context.on('close', () => {
        for (const upstream of upstreams) {
            upstream.close();
        }

        upstreams.clear();
    });
}
