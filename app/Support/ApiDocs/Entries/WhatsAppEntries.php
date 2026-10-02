<?php

namespace App\Support\ApiDocs\Entries;

use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppConnectionTestData;
use App\Data\WhatsApp\WhatsAppQrData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Data\WhatsApp\WhatsAppSettingsData;
use App\Data\WhatsApp\WidgetWhatsAppLinkData;
use App\Support\ApiDocs\Doc;

/**
 * WhatsApp (hand-off and record through the self-hosted OpenWA gateway). Administrators only everywhere: agents never see a
 * WhatsApp chat, and the webhook is called by the gateway, not by clients.
 */
final class WhatsAppEntries implements EntryList
{
    private const SESSION_ERRORS = ['openwa_not_configured', 'openwa_unavailable', 'openwa_unauthorized', 'openwa_rejected'];

    public static function docs(): array
    {
        return [
            Doc::route('api.whatsapp.sessions.index')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('List WhatsApp sessions')
                ->about('Live sessions, oldest first (deleted ones are not listed). Never carries the webhook secret, the gateway key, an OpenWA id or the QR image.')
                ->list(WhatsAppSessionData::class),

            Doc::route('api.whatsapp.sessions.store')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Create a WhatsApp session')
                ->about('Creates the session here and at the gateway (status `created`); starting it is a separate call.')
                ->created(WhatsAppSessionData::class)
                ->errors(['session_name_taken', 'openwa_session_exists', 'session_name_teardown_pending', ...self::SESSION_ERRORS, 'validation_failed' => 'The name is not 3 to 50 letters, digits or hyphens.']),

            Doc::route('api.whatsapp.sessions.show')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Show a WhatsApp session')
                ->item(WhatsAppSessionData::class),

            Doc::route('api.whatsapp.sessions.update')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Change a session\'s sending limits')
                ->about('The session\'s pacing overrides; `null` goes back to the global setting.')
                ->item(WhatsAppSessionData::class),

            Doc::route('api.whatsapp.sessions.destroy')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Delete a WhatsApp session')
                ->about("Deletes the session at the gateway (its webhooks and the gateway's copy of the messages go with it), then soft-deletes it here: the name is free again, its chats stay readable and widgets linked to it behave as unlinked. `force=1` deletes locally even when the gateway cannot be asked (the gateway's session may then stay behind).")
                ->noContent(204, 'Deleted.')
                ->errors(['session_name_teardown_pending', 'openwa_unavailable']),

            Doc::route('api.whatsapp.sessions.start')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Start a WhatsApp session')
                ->about('Quick synchronous steps (create the session at the gateway when it is missing, register the webhook once) and then a queued job asks the gateway to start the engine: that call blocks 5 to 25 seconds while the engine comes up, and the QR and `ready` events land DURING it. The answer is `202` with status `starting`; follow `wa.session.status` on the admin channel or `GET .../qr`.')
                ->item(WhatsAppSessionData::class, 202, 'The engine is starting.')
                ->errors(['session_not_startable', 'webhook_rejected', 'webhook_limit_reached', ...self::SESSION_ERRORS]),

            Doc::route('api.whatsapp.sessions.stop')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Stop a WhatsApp session')
                ->about('Status becomes `disconnected`; the session stays down until it is started again.')
                ->item(WhatsAppSessionData::class)
                ->errors(['session_not_stoppable', 'openwa_unavailable', 'openwa_unauthorized']),

            Doc::route('api.whatsapp.sessions.sync')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Sync a session with the gateway')
                ->about('Asks the gateway what it knows (status, number, push name, last error) and stores that. A session the gateway no longer knows becomes `failed`. The scheduled `whatsapp:reconcile-sessions` does the same every minute.')
                ->item(WhatsAppSessionData::class)
                ->errors(['openwa_unavailable', 'openwa_unauthorized']),

            Doc::route('api.whatsapp.sessions.webhook')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Register the webhook again')
                ->about('Registers the webhook again with a **new** random secret and removes the old one at the gateway. The recovery for a webhook that no longer verifies (the application key changed, a database was restored, the webhook was edited at the gateway); normal use never needs it. Audited.')
                ->item(WhatsAppSessionData::class)
                ->errors(['webhook_rejected', 'webhook_limit_reached', 'openwa_unavailable', 'openwa_unauthorized']),

            Doc::route('api.whatsapp.sessions.qr')
                ->in('WhatsApp (admin only)', 'Sessions')
                ->title('Get the pairing QR')
                ->about('Only while the session waits for a scan (`status: qr`). Served from the last webhook while it is younger than 45 seconds, else fetched from the gateway. A QR is a login credential while it is valid: `Cache-Control: no-store`, render it in an `<img>` only, poll every 2 to 3 seconds.')
                ->item(WhatsAppQrData::class)
                ->errors(['qr_not_available', 'openwa_unavailable', 'openwa_unauthorized']),

            Doc::route('api.whatsapp.settings.show')
                ->in('WhatsApp (admin only)', 'Settings')
                ->title('Show the WhatsApp settings')
                ->about('The API key is **write-only**: only `hasApiKey` says one is saved.')
                ->item(WhatsAppSettingsData::class),

            Doc::route('api.whatsapp.settings.update')
                ->in('WhatsApp (admin only)', 'Settings')
                ->title('Change the WhatsApp settings')
                ->about('Any subset. A changed `base_url` needs `api_key` in the same request (a stored key is never reused for a new destination). The address goes through the outbound address guard (private and loopback addresses need `PORTAL_ALLOW_PRIVATE_HOSTS`). Audited with field names only, never a value of the key.')
                ->item(WhatsAppSettingsData::class)
                ->errors(['validation_failed' => 'A value is out of range, the address is refused, `handoff_text` lacks `:code`, or a new `base_url` came without `api_key`.']),

            Doc::route('api.whatsapp.settings.test')
                ->in('WhatsApp (admin only)', 'Settings')
                ->title('Test the saved gateway connection')
                ->about('Tests the SAVED address and key (no body). `ok: true` carries the key\'s `role` and `canOperate`; `ok: false` carries a `reason` and one sentence. The key and the address never appear in the answer.')
                ->item(WhatsAppConnectionTestData::class),

            Doc::route('api.whatsapp.chats.index')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('List WhatsApp chats')
                ->about('The admin inbox, newest activity first, cursor-paged. `meta.unread_chats` counts the open chats with unread messages (all sessions, ignoring the filters).')
                ->paged(WaChatData::class, 'A page of chats.', true, ['unread_chats' => 3])
                ->without('from', 'to', 'format', 'resource')
                ->errors(['validation_failed' => 'A filter is invalid or the cursor is not ours.']),

            Doc::route('api.whatsapp.chats.show')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Show a WhatsApp chat')
                ->about('The chat with what links it to the website (the visitor and the hand-off ticket), both `null` for a chat no ticket matched. Opening a chat does not mark it read.')
                ->item(WaChatDetailData::class),

            Doc::route('api.whatsapp.chats.destroy')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Erase a WhatsApp chat')
                ->about('Erases the chat, all its messages and their stored images for good. **Idempotent:** a chat that is already gone, or an unknown ulid, is `204` as well. Audited (ulid and counts only, never a number, name or text). A hand-off ticket that linked the chat stays, unlinked.')
                ->noContent(204, 'Erased (or already gone).'),

            Doc::route('api.whatsapp.chats.read')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Mark a WhatsApp chat read')
                ->item(WaChatData::class),

            Doc::route('api.whatsapp.chats.archive')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Archive a WhatsApp chat')
                ->about('A new inbound message re-opens an archived chat.')
                ->item(WaChatData::class),

            Doc::route('api.whatsapp.chats.unarchive')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Unarchive a WhatsApp chat')
                ->item(WaChatData::class),

            Doc::route('api.whatsapp.chats.messages.index')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('List the messages of a WhatsApp chat')
                ->about('A transcript page, always oldest first. Neither cursor = the newest page; `after_id` is the sync call after a reconnect; `before_id` the page before. `next_cursor` is the `after_id` of the following page (`null` at the newest end), `prev_cursor` the `before_id` of the previous one (`null` at the start).')
                ->paged(WaMessageData::class, 'A page of messages.', true, ['prev_cursor' => null])
                ->errors(['validation_failed' => 'An unknown or foreign message ulid.']),

            Doc::route('api.whatsapp.chats.messages.store')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Reply in a WhatsApp chat')
                ->about("The message is stored `pending` and queued; a worker sends it (`sent`, then `delivered` / `read` / `failed` as the gateway's acks arrive). A repeated `client_msg_id` answers `200` with the original. The application protects the number: `reply_only_to_inbound`, a minimum interval between sends (a request that arrives too early is not refused, its job waits for its slot) and a daily cap per session.")
                ->created(WaMessageData::class, 'Stored and queued (`pending`).')
                ->item(WaMessageData::class, 200, 'A repeat of a `client_msg_id`: the original.')
                ->errors(['session_not_ready', 'reply_not_allowed', 'daily_cap_reached', 'queue_unavailable', 'validation_failed' => 'The body is empty after cleaning or too long.']),

            Doc::route('api.whatsapp.export')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Export WhatsApp data')
                ->about('Streams messages (default) or chats as CSV (default) or JSON with the inbox filters (`status` defaults to `all` here) and `from` / `to` on the message time. Formula-injection safe (a phone number `+49...` carries a leading quote in the CSV, not in the JSON). Audited.')
                ->raw(200, 'text/csv; charset=utf-8', "chat,direction,type,body,status,wa_timestamp\n", 'A CSV or JSON file.', ['Content-Disposition' => 'attachment; filename="whatsapp-messages-20260930-120000.csv"', 'Cache-Control' => 'no-store'])
                ->without('limit', 'cursor')
                ->errors(['validation_failed' => 'A filter is invalid.']),

            Doc::route('whatsapp.media.show')
                ->in('WhatsApp (admin only)', 'Inbox')
                ->title('Fetch a stored WhatsApp image')
                ->about('The target of the signed `media.url` in message payloads (60 minutes). Two credentials: the URL signature (an `<img>` cannot send a bearer token) AND an administrator\'s session, so a URL that leaks is useless to anybody else. Streamed from the private disk with `nosniff` and a sandboxing CSP.')
                ->raw(200, 'image/jpeg', '<<binary>>The stored image.', 'The image bytes.', ['X-Content-Type-Options' => 'nosniff', 'Content-Security-Policy' => "default-src 'none'; sandbox", 'Cache-Control' => 'private, max-age=600'])
                ->errors(['forbidden' => 'Bad or expired signature, or not an administrator.']),

            Doc::route('api.widgets.whatsapp.show')
                ->in('WhatsApp (admin only)', 'Widget link')
                ->title('Show the WhatsApp link of a widget')
                ->item(WidgetWhatsAppLinkData::class),

            Doc::route('api.widgets.whatsapp.update')
                ->in('WhatsApp (admin only)', 'Widget link')
                ->title('Link a widget to a WhatsApp session')
                ->about('Links the widget to a live session, or unlinks it with `session: null`. Audited; the widget\'s cached config and availability are dropped.')
                ->item(WidgetWhatsAppLinkData::class)
                ->errors(['validation_failed' => '`details.session`: unknown or deleted session.']),

            Doc::route('webhooks.openwa')
                ->in('WhatsApp (admin only)', 'Webhook')
                ->title('OpenWA webhook (inbound)')
                ->about("Called by the OpenWA gateway for the session registered with this URL, never by a client. Before anything is stored: the body is at most 1 MiB, and `X-OpenWA-Signature: sha256=<hex>` must equal the HMAC-SHA256 of the **raw body** with the session's webhook secret (constant-time compare). Missing, malformed, wrong or another session's signature all answer the same `401`. Everything is read from the signed body; the other `X-OpenWA-*` headers are never read.\n\nA verified delivery is stored on a ledger (unique per session and idempotency key) and answered at once: `accepted`, or `duplicate` for a repeat; a queued job applies it. Events handled: `message.received`, `message.sent`, `message.ack`, `message.failed`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`, `session.reconnect_loop`; anything else is acknowledged and ignored.")
                ->header('X-OpenWA-Signature', 'sha256=3b1f0c9e5a7d2e4f6a8b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7', 'Hex HMAC-SHA256 of the raw request body, keyed with the session\'s webhook secret, prefixed `sha256=`.')
                ->param('event', ['description' => 'The event name (letters, digits, dots, hyphens, underscores).', 'example' => 'message.received'])
                ->data(['status' => 'accepted'], 200, 'Stored for processing (`duplicate` when the same delivery arrives again).', ['status' => ['description' => '`accepted` or `duplicate`.']])
                ->errors(['invalid_webhook', 'payload_too_large', 'unauthenticated' => 'The signature is missing, malformed or wrong.']),
        ];
    }
}
