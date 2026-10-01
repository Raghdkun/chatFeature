import type { Dict } from './types';
import { isRecord, uuid } from './util';

/**
 * Host side of the postMessage protocol (docs/contracts/postmessage-protocol.md).
 *
 * Inbound: only messages with `event.origin === appOrigin` AND `event.source === iframe.contentWindow`, and a
 * well-formed `{ns:'chatfeature', v:1, type, payload}` envelope, get past `handle`. Everything else is
 * silently ignored. Outbound: always `postMessage(msg, appOrigin)`, never `'*'`.
 *
 * Handshake: the panel sends `ready`; we answer `init` (with an `id`) and re-send it every `retryMs` until it
 * is acknowledged (`init:result` with the same id, or, for panels that do not ack, their first `state` /
 * `session` message). `readyTimeoutMs` bounds both waits. Host messages sent before the ack are queued.
 */

export const HANDSHAKE_MS = 10_000;
export const RETRY_MS = 1_000;

export interface BridgeOptions {
    win: Window;
    iframe: HTMLIFrameElement;
    origin: string;
    /** Builds the `init` payload (called again on every retry so viewport/page stay fresh). */
    init: () => Dict;
    onMessage: (type: string, payload: Dict) => void;
    onTimeout: (code: 'ready_timeout' | 'init_timeout') => void;
}

export class Bridge {
    /** The panel announced `ready` at least once. */
    panelReady = false;
    /** `init` was acknowledged; queued messages have been flushed. */
    acked = false;
    private initId: string | null = null;
    private outbox: [string, Dict][] = [];
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private readonly listener = (e: MessageEvent): void => this.handle(e);

    constructor(private readonly o: BridgeOptions) {
        o.win.addEventListener('message', this.listener);
        this.arm('ready_timeout');
    }

    private arm(code: 'ready_timeout' | 'init_timeout'): void {
        this.clearTimers();
        this.timeout = setTimeout(() => {
            this.clearTimers();
            this.o.onTimeout(code);
        }, HANDSHAKE_MS);
    }

    private clearTimers(): void {
        for (const t of [this.timeout, this.retry]) {
            if (t !== null) {
                clearTimeout(t);
            }
        }

        this.timeout = this.retry = null;
    }

    private handle(e: MessageEvent): void {
        if (
            this.disposed ||
            e.origin !== this.o.origin ||
            e.source === null ||
            e.source !== this.o.iframe.contentWindow
        ) {
            return;
        }

        const d: unknown = e.data;

        if (
            !isRecord(d) ||
            d.ns !== 'chatfeature' ||
            d.v !== 1 ||
            typeof d.type !== 'string'
        ) {
            return;
        }

        const payload = isRecord(d.payload) ? d.payload : {};

        if (d.type === 'ready') {
            if (payload.protocol !== undefined && payload.protocol !== 1) {
                return;
            }

            this.panelReady = true;
            this.acked = false;
            this.initId = uuid();
            this.arm('init_timeout');
            this.sendInit();

            return;
        }

        if (d.type === 'init:result') {
            if (d.id === this.initId) {
                this.ack();
            }

            return;
        }

        // Panels that do not answer `init:result` prove they processed it by speaking first.
        if (
            !this.acked &&
            this.initId !== null &&
            (d.type === 'state' || d.type === 'session')
        ) {
            this.ack();
        }

        this.o.onMessage(d.type, payload);
    }

    private sendInit(): void {
        if (this.disposed || this.acked || this.initId === null) {
            return;
        }

        this.post('init', this.o.init(), this.initId);
        this.retry = setTimeout(() => this.sendInit(), RETRY_MS);
    }

    private ack(): void {
        if (this.acked) {
            return;
        }

        this.acked = true;
        this.clearTimers();

        for (const [type, payload] of this.outbox.splice(0)) {
            this.post(type, payload);
        }
    }

    private post(type: string, payload: Dict, id?: string): void {
        try {
            this.o.iframe.contentWindow?.postMessage(
                {
                    ns: 'chatfeature',
                    v: 1,
                    type,
                    ...(id === undefined ? {} : { id }),
                    payload,
                },
                this.o.origin,
            );
        } catch {
            // detached frame or non-cloneable payload: nothing sensible to do
        }
    }

    /** Sends a host -> panel message, queueing it until the handshake is acknowledged. */
    send(type: string, payload: Dict = {}): void {
        if (this.disposed) {
            return;
        }

        if (this.acked) {
            this.post(type, payload);

            return;
        }

        // Only the latest viewport matters; everything else keeps its order.
        if (type === 'viewport') {
            this.outbox = this.outbox.filter(([t]) => t !== 'viewport');
        }

        this.outbox.push([type, payload]);
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimers();
        this.outbox = [];
        this.o.win.removeEventListener('message', this.listener);
    }
}
