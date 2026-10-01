/**
 * The panel's end of the postMessage channel to the host page (docs/contracts/postmessage-protocol.md).
 *
 * Inbound, in this order: the message must come from the parent window (`event.source === parent`), be a well-formed
 * `{ns:'chatfeature', v:1, ...}` envelope that `parseHostMessage` accepts, and come from an allowed origin: the widget's domain
 * whitelist (inlined by the Blade shell), or, in the admin-only builder preview, this app's own origin. The origin of the first valid
 * `init` is pinned: from then on only that origin is listened to and every reply goes to it, never to `'*'`.
 *
 * The one exception is the very first `ready` beacon. It carries only `{protocol: 1}` and is sent before the host origin is known:
 * it is aimed at the embedding page's origin when `document.referrer` / `ancestorOrigins` name one that is allowed, and falls
 * back to `'*'` otherwise (nothing in it is worth stealing; the loader checks who answers).
 */
import { originMatches } from '@/embed/protocol/origin';
import {
    envelope,
    isRecord,
    parseHostMessage,
    type HostMessage,
    type PanelMessage,
} from '@/embed/protocol/messages';

export type HostChannelOptions = {
    win: Window;
    appOrigin: string;
    allowedHosts: readonly string[];
    /** `?preview=1` (admin-only builder preview): `draft` messages and `init` from the app's own origin are accepted. */
    preview: boolean;
    /** Candidate origins of the embedding page, best first (`document.referrer`, `location.ancestorOrigins[0]`). */
    hintOrigins?: readonly (string | null | undefined)[];
    /** Defaults to `win.parent`. */
    parent?: Window | null;
    /** Called for every accepted message (`init` included, the acknowledgement is sent right after it returns). */
    onMessage: (message: HostMessage, origin: string) => void;
    /** `ready` is repeated this often until an `init` arrives (milliseconds, 0 = never). */
    readyRetryMs?: number;
    readyRetries?: number;
};

export class HostChannel {
    private hostOrigin: string | null = null;
    private started = false;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly parent: Window | null;
    private readonly listener = (event: MessageEvent): void =>
        this.handle(event);

    constructor(private readonly options: HostChannelOptions) {
        const parent = options.parent ?? options.win.parent;

        this.parent = parent === options.win ? null : parent;
    }

    /** Whether there is a parent window at all (false for the hosted page and a top-level visit). */
    get hasParent(): boolean {
        return this.parent !== null;
    }

    /** The pinned host origin once an `init` was accepted. */
    get origin(): string | null {
        return this.hostOrigin;
    }

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        this.options.win.addEventListener('message', this.listener);

        if (this.parent !== null) {
            this.announce(0);
        }
    }

    stop(): void {
        this.started = false;
        clearTimeout(this.retryTimer);
        this.options.win.removeEventListener('message', this.listener);
    }

    private announce(attempt: number): void {
        if (!this.started || this.hostOrigin !== null) {
            return;
        }

        this.post({ type: 'ready', payload: { protocol: 1 } }, this.target());

        const every = this.options.readyRetryMs ?? 2000;

        if (every > 0 && attempt < (this.options.readyRetries ?? 4)) {
            this.retryTimer = setTimeout(
                () => this.announce(attempt + 1),
                every,
            );
        }
    }

    private isAllowed(origin: string): boolean {
        return (
            originMatches(origin, this.options.allowedHosts) ||
            (this.options.preview && origin === this.options.appOrigin)
        );
    }

    private target(): string {
        for (const hint of this.options.hintOrigins ?? []) {
            if (
                typeof hint === 'string' &&
                hint !== '' &&
                this.isAllowed(hint)
            ) {
                return hint;
            }
        }

        return '*';
    }

    private post(message: PanelMessage, targetOrigin: string): void {
        try {
            this.parent?.postMessage(envelope(message), targetOrigin);
        } catch {
            // a detached parent or a non-cloneable payload: nothing sensible to do
        }
    }

    /** Sends a panel -> host message to the pinned origin. Silently dropped until the host has said `init`. */
    send(message: PanelMessage): void {
        if (this.hostOrigin === null) {
            return;
        }

        this.post(message, this.hostOrigin);
    }

    private handle(event: MessageEvent): void {
        if (this.parent === null || event.source !== this.parent) {
            return;
        }

        const data: unknown = event.data;

        // Cheap pre-check so unrelated page traffic never reaches the parser.
        if (!isRecord(data) || data.ns !== 'chatfeature') {
            return;
        }

        const message = parseHostMessage(data);

        if (message === null) {
            return;
        }

        const { origin } = event;

        if (message.type === 'draft') {
            if (this.options.preview && origin === this.options.appOrigin) {
                this.options.onMessage(message, origin);
            }

            return;
        }

        if (this.hostOrigin === null) {
            if (message.type !== 'init' || !this.isAllowed(origin)) {
                return;
            }

            this.hostOrigin = origin;
            clearTimeout(this.retryTimer);
        } else if (origin !== this.hostOrigin) {
            return;
        }

        this.options.onMessage(message, origin);

        if (message.type === 'init' && message.id !== undefined) {
            this.post(
                { type: 'init:result', payload: {}, id: message.id },
                origin,
            );
        }
    }
}
