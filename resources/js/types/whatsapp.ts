/**
 * Inertia props of the WhatsApp pages (admin only, P6). Every nested shape is a generated PHP Data type (`App.Data.WhatsApp.*`, short
 * names in `@/lib/whatsapp/types`); the compile-time guard in `whatsapp.conformance.ts` fails `npm run types:check` when they drift.
 * The few settings values the pages receive are plain arrays built by the page controllers (`WhatsAppPageController`).
 */
import type { WaSettings } from '@/lib/whatsapp-api/types';
import type {
    WaChat,
    WaChatDetail,
    WaMessage,
    WhatsAppSession,
} from '@/lib/whatsapp/types';

/** What the inbox shell needs besides the chats: the sessions (filter + live status) and the one setting that decides who may be answered. */
export type WaInboxShellProps = {
    /** The first page of the open chats, most recent first (the filters and "load more" go through the API). */
    chats: WaChat[];
    /** There are more chats than the first page: the list reads page 1 over the API once to learn where "load more" continues. */
    hasMore: boolean;
    sessions: WhatsAppSession[];
    /** `whatsapp.reply_only_to_inbound`. */
    replyOnlyToInbound: boolean;
};

export type WaInboxPageProps = WaInboxShellProps;

export type WaInboxShowProps = WaInboxShellProps & {
    detail: WaChatDetail;
    /** The newest messages of the chat, oldest first. */
    messages: WaMessage[];
    /** There is older history than `messages` starts with. */
    hasOlder: boolean;
};

export type WaSettingsPageProps = {
    sessions: WhatsAppSession[];
    settings: WaSettings;
};
