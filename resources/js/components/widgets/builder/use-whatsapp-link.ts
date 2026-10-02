/**
 * What the builder's WhatsApp tab reads and writes: which session serves this widget (`GET|PUT /widgets/{ulid}/whatsapp`, live as soon as
 * it is saved), the sessions to choose from, and the global settings the visitor-facing side depends on (the master switch, the hand-off
 * text). Loaded when the tab opens, not with the builder page: an administrator who never opens the tab costs no request.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWaApi } from '@/lib/realtime/whatsapp/context';
import type { WaSettings, WidgetWhatsAppLink } from '@/lib/whatsapp-api/types';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

export type WhatsAppLinkState =
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | {
          status: 'ready';
          link: WidgetWhatsAppLink;
          sessions: WhatsAppSession[];
          settings: WaSettings;
      };

export function useWhatsAppLink(widgetUlid: string) {
    const api = useWaApi();
    const [tick, setTick] = useState(0);
    // What was read, and for which widget / which attempt: anything else on screen is "loading" (a retry needs no reset effect).
    const key = `${widgetUlid}:${tick}`;
    const [read, setRead] = useState<{
        key: string;
        value: Exclude<WhatsAppLinkState, { status: 'loading' }>;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;

        Promise.all([
            api.widgetWhatsApp(widgetUlid),
            api.sessions(),
            api.settings(),
        ]).then(
            ([link, sessions, settings]) => {
                if (!cancelled) {
                    setRead({
                        key,
                        value: { status: 'ready', link, sessions, settings },
                    });
                }
            },
            (error: unknown) => {
                if (!cancelled) {
                    setRead({ key, value: { status: 'error', error } });
                }
            },
        );

        return () => {
            cancelled = true;
        };
    }, [api, widgetUlid, key]);

    const state: WhatsAppLinkState =
        read !== null && read.key === key ? read.value : { status: 'loading' };
    const reload = useCallback(() => setTick((n) => n + 1), []);

    /** Link the widget to a session (`null`: none). Throws the API error; on success the new link replaces the old one. */
    const choose = useCallback(
        async (sessionUlid: string | null): Promise<WidgetWhatsAppLink> => {
            const link = await api.setWidgetWhatsApp(widgetUlid, sessionUlid);

            setRead((held) =>
                held !== null && held.value.status === 'ready'
                    ? { ...held, value: { ...held.value, link } }
                    : held,
            );

            return link;
        },
        [api, widgetUlid],
    );

    return { state, reload, choose };
}
