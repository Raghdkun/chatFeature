/**
 * Every URL of the WhatsApp UI (P6, admin only), in one place: the three dashboard pages and the management API of track 6A
 * (`/api/v1/whatsapp/*`, `wa.admin`: an agent gets `403`). No screen spells a path itself.
 *
 * The page routes are `routes/web/whatsapp.php`; the API paths are the "WhatsApp API (P6)" section of docs/rest-api.md (track 6A).
 */
const API = '/api/v1';
const enc = encodeURIComponent;

export const waRoutes = {
    pages: {
        inbox: () => '/whatsapp',
        chat: (ulid: string) => `/whatsapp/chats/${enc(ulid)}`,
        settings: () => '/settings/whatsapp',
    },
    api: {
        settings: () => `${API}/whatsapp/settings`,
        connectionTest: () => `${API}/whatsapp/settings/test`,
        sessions: () => `${API}/whatsapp/sessions`,
        session: (ulid: string) => `${API}/whatsapp/sessions/${enc(ulid)}`,
        sessionStart: (ulid: string) =>
            `${API}/whatsapp/sessions/${enc(ulid)}/start`,
        sessionStop: (ulid: string) =>
            `${API}/whatsapp/sessions/${enc(ulid)}/stop`,
        sessionSync: (ulid: string) =>
            `${API}/whatsapp/sessions/${enc(ulid)}/sync`,
        /** `no-store`: a QR code is a login credential while it is valid. */
        sessionQr: (ulid: string) => `${API}/whatsapp/sessions/${enc(ulid)}/qr`,
        chats: () => `${API}/whatsapp/chats`,
        chat: (ulid: string) => `${API}/whatsapp/chats/${enc(ulid)}`,
        chatMessages: (ulid: string) =>
            `${API}/whatsapp/chats/${enc(ulid)}/messages`,
        chatRead: (ulid: string) => `${API}/whatsapp/chats/${enc(ulid)}/read`,
        chatArchive: (ulid: string) =>
            `${API}/whatsapp/chats/${enc(ulid)}/archive`,
        chatUnarchive: (ulid: string) =>
            `${API}/whatsapp/chats/${enc(ulid)}/unarchive`,
        /** An administrator's download (`?format=csv|json`, `resource=messages|chats`, the list filters). */
        export: () => `${API}/whatsapp/export`,
        /** Which session serves a widget (`GET` / `PUT {session}`; the widget builder's WhatsApp tab). */
        widgetWhatsApp: (widgetUlid: string) =>
            `${API}/widgets/${enc(widgetUlid)}/whatsapp`,
    },
    /** The visitor panel's call (bearer token, no cookies): `base` is the boot config's `api.base`, so no `/api/v1/public` here. */
    handoff: (widgetKey: string) =>
        `/widgets/${enc(widgetKey)}/whatsapp-handoff`,
} as const;
