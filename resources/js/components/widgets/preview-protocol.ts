/**
 * Messages of the builder preview (docs/contracts/postmessage-protocol.md).
 *
 *   builder page ──draft──▶ preview host document (same origin, `srcdoc`) ──draft──▶ widget iframe
 *
 * The widget iframe only accepts `event.source === window.parent` from an allowed origin, and the
 * preview host document is its parent, so the builder never talks to the widget iframe directly:
 * a tiny relay inside the host document (see `preview-host.ts`) forwards the draft. Status flows
 * back on a separate namespace so it can never be mistaken for a widget message.
 */
import type { GreetingDraft } from '@/components/widgets/builder-state';
import { toBootGreeting, toClientConfig } from '@/lib/widget-config';
import type {
    BootGreeting,
    ThemeMode,
    WidgetConfigData,
} from '@/types/widgets';

/** Namespace of the chat widget protocol (envelope `ns`). */
export const CHAT_NS = 'chatfeature' as const;
export const PROTOCOL_VERSION = 1 as const;

/** Namespace of the preview host document's status messages to the builder. */
export const PREVIEW_HOST_NS = 'chatfeature-preview' as const;

export type DraftMessage = {
    ns: typeof CHAT_NS;
    v: typeof PROTOCOL_VERSION;
    type: 'draft';
    payload: {
        config: ReturnType<typeof toClientConfig>;
        greetings: BootGreeting[];
    };
};

export type PreviewScheme = 'light' | 'dark';

/** The preview always shows an explicit scheme, so `auto` (follow the OS) is overridden. */
export function withPreviewScheme(
    config: WidgetConfigData,
    scheme: PreviewScheme,
): WidgetConfigData {
    const mode: ThemeMode = scheme;

    return { ...config, theme: { ...config.theme, mode } };
}

/** `{ ns:'chatfeature', v:1, type:'draft', payload:{ config, greetings } }` for the unsaved draft. */
export function buildDraftMessage(
    config: WidgetConfigData,
    greetings: GreetingDraft[],
): DraftMessage {
    return {
        ns: CHAT_NS,
        v: PROTOCOL_VERSION,
        type: 'draft',
        payload: {
            config: toClientConfig(config),
            greetings: greetings
                .filter(
                    (greeting) =>
                        greeting.is_active && greeting.body.trim() !== '',
                )
                .map((greeting) =>
                    toBootGreeting({
                        ...greeting,
                        id: greeting.ulid ?? greeting.clientId,
                    }),
                ),
        },
    };
}

/**
 * The subset the loader accepts as a runtime `ChatFeature('update', ...)` (restyle, never expand;
 * see "Precedence and client overrides" in widget-config.md).
 */
export function restyleOverrides(config: WidgetConfigData) {
    const { theme, launcher, texts, defaultLocale, greetings } = config;

    return { defaultLocale, theme, launcher, texts, greetings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Did the edit from `previous` to `next` take something away (a text override cleared, an icon /
 * avatar / font URL emptied, a language removed)? A runtime `ChatFeature('update', ...)` only ever
 * adds and overrides, so such a removal is invisible to the running loader until it boots again.
 */
export function dropsOverrides(previous: unknown, next: unknown): boolean {
    if (isRecord(previous) && isRecord(next)) {
        return Object.entries(previous).some(([key, value]) =>
            key in next
                ? dropsOverrides(value, next[key])
                : value !== undefined && value !== null,
        );
    }

    return (
        previous !== undefined &&
        previous !== null &&
        (next === undefined || next === null)
    );
}

export type HostStatus = {
    ns: typeof PREVIEW_HOST_NS;
    v: typeof PROTOCOL_VERSION;
    type: 'status';
    /** The loader script finished loading in the host document. */
    loader: 'loading' | 'ready' | 'error';
    /** The widget (chat) iframe has been created by the loader. */
    frame: boolean;
};

/** Only trust status messages from our own frame, same origin, in our namespace. */
export function parseHostStatus(
    event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
    frameWindow: Window | null | undefined,
    ownOrigin: string,
): HostStatus | null {
    if (
        !frameWindow ||
        event.source !== frameWindow ||
        event.origin !== ownOrigin
    ) {
        return null;
    }

    const data = event.data as Partial<HostStatus> | null;

    if (
        !data ||
        data.ns !== PREVIEW_HOST_NS ||
        data.v !== PROTOCOL_VERSION ||
        data.type !== 'status' ||
        (data.loader !== 'loading' &&
            data.loader !== 'ready' &&
            data.loader !== 'error')
    ) {
        return null;
    }

    return {
        ns: PREVIEW_HOST_NS,
        v: PROTOCOL_VERSION,
        type: 'status',
        loader: data.loader,
        frame: data.frame === true,
    };
}

export type PreviewCommandName = 'open' | 'close' | 'toggle';

export type PreviewCommand = {
    ns: typeof PREVIEW_HOST_NS;
    v: typeof PROTOCOL_VERSION;
    type: 'command';
    name: PreviewCommandName;
};

/** Asks the host document's relay to call `ChatFeature(name)` (open / close the chat panel). */
export function buildCommandMessage(name: PreviewCommandName): PreviewCommand {
    return { ns: PREVIEW_HOST_NS, v: PROTOCOL_VERSION, type: 'command', name };
}
