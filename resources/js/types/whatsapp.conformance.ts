/**
 * Compile-time drift guard for the WhatsApp UI (admin-only, P6): the shapes the UI declares (page props, API bodies, realtime payloads)
 * must stay identical to the generated PHP Data types (`App.Data.WhatsApp.*`). If a Data class changes without the UI following, or the
 * other way round, `npm run types:check` fails here. Nothing in this file runs.
 */
import type { WaEventPayloads } from '@/lib/chat/events';
import type { HandoffRequest } from '@/lib/chat-api/visitor';
import type { WaSettings, WidgetWhatsAppLink } from '@/lib/whatsapp-api/types';
import type * as W from '@/lib/whatsapp/types';
import type {
    WaInboxPageProps,
    WaSettingsPageProps,
    WaWidgetLink,
} from '@/types/whatsapp';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Row<T> = T extends readonly (infer R)[] ? R : never;

/**
 * The four Data classes track 6A added (`WhatsAppSettingsData`, `WhatsAppQrData`, `WhatsAppConnectionTestData`,
 * `WidgetWhatsAppLinkData`) are not in this branch's generated file yet. Until the integrator regenerates (`composer types:generate`
 * after merging 6A), these are their PHP constructors written out; the day `App.Data.WhatsApp.WhatsAppSettingsData` exists, replace
 * each mirror below by the generated type and delete the mirror.
 */
type WhatsAppSettingsData = {
    enabled: boolean;
    baseUrl: string;
    hasApiKey: boolean;
    handoffTtlMinutes: number;
    handoffText: string;
    ignoreGroups: boolean;
    replyOnlyToInbound: boolean;
    sendMinIntervalMs: number;
    dailySendCap: number;
    mediaMaxBytes: number;
};
type WidgetWhatsAppLinkData = {
    widget: App.Data.Chat.WidgetRefData;
    session: App.Data.WhatsApp.WaSessionRefData | null;
    status: App.Domain.WhatsApp.Enums.SessionStatus | null;
    maskedPhone: string | null;
    connected: boolean;
};

/** The two inbox pages' props are made of the generated Data classes, field for field. */
export const inboxPageConforms: {
    sessions: Same<
        Row<WaInboxPageProps['sessions']>,
        App.Data.WhatsApp.WhatsAppSessionData
    >;
    chats: Same<Row<WaInboxPageProps['chats']>, App.Data.WhatsApp.WaChatData>;
    widgets: Same<
        Row<WaInboxPageProps['widgets']>,
        App.Data.Chat.WidgetRefData
    >;
    categories: Same<
        Row<WaInboxPageProps['categories']>,
        App.Data.Chat.CategoryRefData
    >;
    detail: Same<
        NonNullable<WaInboxPageProps['selected']>['detail'],
        App.Data.WhatsApp.WaChatDetailData
    >;
    messages: Same<
        Row<NonNullable<WaInboxPageProps['selected']>['messages']>,
        App.Data.WhatsApp.WaMessageData
    >;
    /** The page controller's `meta` is the API's own, snake_case. */
    meta: Same<
        WaInboxPageProps['meta'],
        { next_cursor: string | null; unread_chats: number }
    >;
    selectedMeta: Same<
        NonNullable<WaInboxPageProps['selected']>['meta'],
        { next_cursor: string | null; prev_cursor: string | null }
    >;
} = {
    sessions: true,
    chats: true,
    widgets: true,
    categories: true,
    detail: true,
    messages: true,
    meta: true,
    selectedMeta: true,
};

/** Settings > WhatsApp's props: the settings, the sessions, the widget links. */
export const settingsPageConforms: {
    sessions: Same<
        Row<WaSettingsPageProps['sessions']>,
        App.Data.WhatsApp.WhatsAppSessionData
    >;
    settings: Same<WaSettingsPageProps['settings'], WhatsAppSettingsData>;
    settingsAreTheApiSettings: Same<WaSettings, WhatsAppSettingsData>;
    widgets: Same<Row<WaSettingsPageProps['widgets']>, WidgetWhatsAppLinkData>;
    link: Same<WaWidgetLink, WidgetWhatsAppLinkData>;
    /** The tab's own link type is the generated one without its widget. */
    linkWithoutWidget: Same<
        WidgetWhatsAppLink,
        Omit<WidgetWhatsAppLinkData, 'widget'>
    >;
    privateHosts: Same<WaSettingsPageProps['privateHostsAllowed'], boolean>;
} = {
    sessions: true,
    settings: true,
    settingsAreTheApiSettings: true,
    widgets: true,
    link: true,
    linkWithoutWidget: true,
    privateHosts: true,
};

/** The short names are the generated types, not copies. */
export const aliasesConform: {
    session: Same<W.WhatsAppSession, App.Data.WhatsApp.WhatsAppSessionData>;
    chat: Same<W.WaChat, App.Data.WhatsApp.WaChatData>;
    detail: Same<W.WaChatDetail, App.Data.WhatsApp.WaChatDetailData>;
    message: Same<W.WaMessage, App.Data.WhatsApp.WaMessageData>;
    media: Same<W.WaMedia, App.Data.WhatsApp.WaMediaData>;
    handoff: Same<W.HandoffResponse, App.Data.WhatsApp.HandoffData>;
    sessionStatus: Same<
        W.SessionStatus,
        App.Domain.WhatsApp.Enums.SessionStatus
    >;
    messageStatus: Same<
        W.WaMessageStatus,
        App.Domain.WhatsApp.Enums.WaMessageStatus
    >;
} = {
    session: true,
    chat: true,
    detail: true,
    message: true,
    media: true,
    handoff: true,
    sessionStatus: true,
    messageStatus: true,
};

/** The realtime payloads the live store reads are the generated ones. */
export const eventsConform: {
    created: Same<
        WaEventPayloads['wa.message.created'],
        App.Data.WhatsApp.Events.WaMessageCreatedPayload
    >;
    updated: Same<
        WaEventPayloads['wa.message.updated'],
        App.Data.WhatsApp.Events.WaMessageUpdatedPayload
    >;
    chat: Same<
        WaEventPayloads['wa.chat.updated'],
        App.Data.WhatsApp.Events.WaChatUpdatedPayload
    >;
    session: Same<
        WaEventPayloads['wa.session.status'],
        App.Data.WhatsApp.Events.WaSessionStatusPayload
    >;
} = {
    created: true,
    updated: true,
    chat: true,
    session: true,
};

/** The visitor's hand-off request is `{ category?: slug }` and nothing else (no name, no phone: the visitor never gives them to us). */
export const handoffRequestConforms: Same<
    HandoffRequest,
    { category?: string }
> = true;
