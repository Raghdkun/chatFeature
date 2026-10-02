/**
 * Inertia props of the WhatsApp pages (admin only, P6): the contract of docs/rest-api.md ("WhatsApp API (P6)", Inertia pages). Every
 * nested shape is a generated PHP Data type (`App.Data.WhatsApp.*`, short names in `@/lib/whatsapp/types`); the compile-time guard in
 * `whatsapp.conformance.ts` fails `npm run types:check` when they drift. Keys that are not Data classes (`meta`) are snake_case, like the
 * API's own `meta`.
 */
import type { WaSettings } from '@/lib/whatsapp-api/types';
import type {
    WaCategoryRef,
    WaChat,
    WaChatDetail,
    WaMessage,
    WaWidgetRef,
    WhatsAppSession,
} from '@/lib/whatsapp/types';

/** `/whatsapp` and `/whatsapp/chats/{chat}`: one page, `selected` is the open chat (`null`: the list only). */
export type WaInboxPageProps = {
    sessions: WhatsAppSession[];
    /** The first page of the open chats, most recent activity first (the filters and "load more" go through the API). */
    chats: WaChat[];
    meta: {
        /** The API's opaque cursor of the second page, when the server knows it; otherwise `has_more` says there is one. */
        next_cursor: string | null;
        /** A page-controller addition: there are more chats than the first page (the list reads page 1 once to learn the cursor). */
        has_more?: boolean;
        /** Open chats with something unread, over every session. */
        unread_chats: number;
    };
    /** What the list can be filtered by. */
    widgets: WaWidgetRef[];
    categories: WaCategoryRef[];
    /** `whatsapp.enabled`: the visitor-facing side (hand-off, availability) is on. Sessions work and chats are recorded either way. */
    whatsappEnabled: boolean;
    /** `whatsapp.reply_only_to_inbound` (a page-controller addition): absent = the composer does not decide early, the API still does. */
    replyOnlyToInbound?: boolean;
    selected: null | {
        detail: WaChatDetail;
        /** The newest messages of the chat, oldest first. */
        messages: WaMessage[];
        meta: {
            next_cursor: string | null;
            /** The `before_id` of the previous page: older history exists while it is set. */
            prev_cursor: string | null;
        };
    };
};

/** `/settings/whatsapp`. */
export type WaSettingsPageProps = {
    sessions: WhatsAppSession[];
    settings: WaSettings;
    /** `PORTAL_ALLOW_PRIVATE_HOSTS` (or local development): OpenWA on a loopback / private address needs it. */
    privateHostsAllowed?: boolean;
};
