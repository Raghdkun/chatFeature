import { EVENT_NAMES } from './types';
import type { EventName } from './types';

type Handler = (data: unknown) => void;

const KNOWN: readonly string[] = EVENT_NAMES;

export const isEventName = (n: unknown): n is EventName =>
    typeof n === 'string' && KNOWN.includes(n);

/** `ChatFeature.on/off` subscribers plus `chatfeature:<name>` DOM CustomEvents (bubbling from `document`). */
export class Emitter {
    private handlers = new Map<string, Set<Handler>>();

    constructor(private readonly doc: Document) {}

    on(name: unknown, fn: unknown): () => void {
        if (!isEventName(name) || typeof fn !== 'function') {
            return () => {};
        }

        const set = this.handlers.get(name) ?? new Set<Handler>();
        set.add(fn as Handler);
        this.handlers.set(name, set);

        return () => this.off(name, fn);
    }

    off(name: unknown, fn: unknown): void {
        if (typeof name === 'string') {
            this.handlers.get(name)?.delete(fn as Handler);
        }
    }

    emit(name: EventName, data: Record<string, unknown> = {}): void {
        for (const fn of Array.from(this.handlers.get(name) ?? [])) {
            try {
                fn(data);
            } catch {
                // a throwing host handler must never break the widget
            }
        }

        try {
            this.doc.dispatchEvent(
                new CustomEvent(`chatfeature:${name}`, {
                    detail: data,
                    bubbles: true,
                }),
            );
        } catch {
            // ignore
        }
    }
}
