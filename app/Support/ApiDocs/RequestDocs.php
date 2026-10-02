<?php

namespace App\Support\ApiDocs;

/**
 * The prose and the example values of the request fields, by Form Request. Types, `required`, enum values and limits are never
 * written here: Scribe reads them from the request's `rules()`. A test pins every key to a field the request really validates.
 *
 * Keys are the Form Request's name relative to `App\Http\Requests\` (two classes are called `ListMessagesRequest`).
 */
final class RequestDocs
{
    private const ULID = ExampleValues::CONVERSATION;

    /**
     * @return array<string, array<string, array{description: string, example?: mixed, type?: string}>>
     */
    public static function all(): array
    {
        $category = ExampleValues::ulid('category');

        return [
            'Chat\\StartSessionRequest' => [
                'identity_token' => ['description' => 'Signed visitor identity: an HS256 JWT the host website\'s backend mints with the widget\'s identity secret. It verifies the visitor and keys them by its `sub`. A token that does not verify is refused (`422`), never downgraded to anonymous.', 'example' => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ3a19rM2o5eDJtNW44cDRxN3IxczZ0MCIsInN1YiI6IjQyIiwiZXhwIjoxNzkwMDAwMzAwfQ.c2lnbmF0dXJl'],
                'visitor' => ['description' => 'Unsigned visitor details. Stored as given and marked unverified.'],
                'visitor.name' => ['description' => 'Display name.', 'example' => 'Ada Lovelace'],
                'visitor.email' => ['description' => 'E-mail address.', 'example' => 'ada@example.com'],
                'visitor.phone' => ['description' => 'Phone number (digits, spaces and `+ ( ) . -`, 3 to 40 characters).', 'example' => '+15551234567'],
                'visitor.meta' => ['description' => 'An object of up to 20 key/value pairs about the visitor. Keys: letters, digits, `.`, `-`, `_`, at most 64 characters. Values: number, boolean or text of at most 500 characters.', 'example' => ['plan' => 'pro'], 'type' => 'object'],
                'page' => ['description' => 'The page the visitor is on, as the host page reports it. Shown to agents, never trusted.'],
                'page.url' => ['description' => 'Page address.', 'example' => 'https://example.com/pricing'],
                'page.title' => ['description' => 'Page title.', 'example' => 'Pricing'],
                'page.referrer' => ['description' => 'Where the visitor came from.', 'example' => 'https://www.google.com/'],
                'locale' => ['description' => 'The visitor\'s locale tag (`en`, `ar`, `pt-BR`).', 'example' => 'en'],
            ],
            'Chat\\StartConversationRequest' => [
                'category' => ['description' => 'Slug of the topic the visitor picked (one of the widget\'s categories, see the config call).', 'example' => 'billing'],
                'message' => ['description' => 'Optional first message; it becomes message 1 of the chat.', 'example' => 'Hi, I need help with my invoice.'],
                'name' => ['description' => 'Pre-chat answer. Whether it is required follows the widget\'s pre-chat setup, enforced here; a field the widget has switched off is ignored.', 'example' => 'Ada Lovelace'],
                'email' => ['description' => 'Pre-chat answer (see `name`).', 'example' => 'ada@example.com'],
                'phone' => ['description' => 'Pre-chat answer (see `name`).', 'example' => '+15551234567'],
                'consent' => ['description' => 'Must be `true` when the widget shows a consent text.', 'example' => true],
            ],
            'Chat\\CreateOfflineTicketRequest' => [
                'name' => ['description' => 'The visitor\'s name (stored as one line).', 'example' => 'Ada Lovelace'],
                'email' => ['description' => 'Where the answer is e-mailed.', 'example' => 'ada@example.com'],
                'message' => ['description' => 'What the visitor needs.', 'example' => 'Nobody was online; please send me last month\'s invoice.'],
                'category' => ['description' => 'Topic slug. Without one the ticket takes the missed chat\'s topic, else the widget\'s first active topic.', 'example' => 'billing'],
                'missed_conversation' => ['description' => 'Ulid of the visitor\'s own `missed` live chat this ticket follows up (recorded on the ticket).', 'example' => self::ULID],
            ],
            'Chat\\SendMessageRequest' => [
                'client_msg_id' => ['description' => 'A ULID the client makes up. Sending the same id again returns the original message with `200` instead of storing a duplicate: retry a failed request safely.', 'example' => '01j9z3q8x7m5n2k4p6r8t0v1w3'],
                'body' => ['description' => 'Plain text, at most `limits.maxMessageLength` characters (default 4000). Required unless `attachments` is given.', 'example' => 'Are you there?'],
                'attachments' => ['description' => 'Ulids of images uploaded to this conversation (`POST .../attachments`), at most 5, shown in this order. Each upload belongs to one conversation and one message.', 'example' => [ExampleValues::ulid('attachment')]],
                'attachments.*' => ['description' => 'Ulid of an uploaded image.', 'example' => ExampleValues::ulid('attachment')],
            ],
            'Chat\\ListMessagesRequest' => [
                'after_seq' => ['description' => 'Return the messages whose `seq` is greater than this (0 or absent: from the start). After a reconnect pass the last `seq` you hold.', 'example' => 14],
                'limit' => ['description' => 'Page size, default 100, at most 200.', 'example' => 100],
            ],
            'Chat\\UploadAttachmentRequest' => [
                'file' => ['description' => 'One image: JPEG, PNG, WebP or a still GIF, within `limits.attachmentMaxBytes` (default 5 MB) and `attachmentMaxDimension` pixels. It is judged by its content, not its name or declared type; SVG, PDF, animated GIFs and anything else is refused. EXIF and other metadata do not survive (the image is re-encoded).'],
            ],
            'Chat\\ReceiptsRequest' => [
                'delivered_upto' => ['description' => 'Highest message `seq` this client has received. At least one of the two fields is required.', 'example' => 14],
                'seen_upto' => ['description' => 'Highest message `seq` the user has actually read (reading implies delivery).', 'example' => 14],
            ],
            'Chat\\TypingRequest' => [
                'typing' => ['description' => '`true` while the user is typing, `false` when they stop. Clients normally whisper over the websocket; this is the REST fallback. Nothing is stored.', 'example' => true],
            ],
            'Chat\\RatingRequest' => [
                'score' => ['description' => 'The rating, 1 to 5.', 'example' => 5],
                'comment' => ['description' => 'Optional comment, at most 2000 characters.', 'example' => 'Quick and helpful, thank you.'],
            ],
            'WhatsApp\\HandoffRequest' => [
                'category' => ['description' => 'Slug of the topic the visitor picked (optional). One live code per visitor and topic.', 'example' => 'billing'],
            ],
            'Chat\\SetPresenceRequest' => [
                'status' => ['description' => 'The status to choose. `offline` stops routing to the agent and keeps them listed.', 'example' => 'online'],
                'automatic' => ['description' => 'Only meaningful with `online`: let heartbeats move the agent between `online` and `away` by whether the app is visible (what the dashboard does) instead of pinning `online`.', 'example' => true],
            ],
            'Chat\\HeartbeatRequest' => [
                'visible' => ['description' => 'Whether the sending app or tab is in the foreground (default `true`). A backgrounded mobile app sends `false` so automatic agents drift to `away` after the auto-away minutes.', 'example' => true],
            ],
            'Chat\\ListConversationsRequest' => [
                'status' => ['description' => 'Comma-separated statuses: `queued`, `active`, `ended`, `closed`, `missed`.', 'example' => 'active,queued'],
                'category' => ['description' => 'Category ulid or slug.', 'example' => 'billing'],
                'widget' => ['description' => 'Widget ulid.', 'example' => ExampleValues::ulid('widget')],
                'agent' => ['description' => 'Assigned agent: a staff user id, or `me`.', 'example' => 'me'],
                'type' => ['description' => '`live` chats or `offline` tickets.', 'example' => 'live'],
                'q' => ['description' => 'Search: part of the ticket number, the visitor\'s name, e-mail or phone, or message text (MySQL FULLTEXT: every word is a prefix and all are required; words under 3 characters use LIKE).', 'example' => 'invoice'],
                'from' => ['description' => 'Created at or after this instant (an offset like `+03:00` is honoured).', 'example' => '2026-09-01T00:00:00Z'],
                'to' => ['description' => 'Created at or before this instant.', 'example' => '2026-09-30T23:59:59Z'],
                'updated_after' => ['description' => 'Changed at or after this instant (inclusive, so a change in the second of your last sync is not lost; merge by ulid). The incremental sync after a reconnect.', 'example' => '2026-09-30T12:00:00.000Z'],
                'limit' => ['description' => 'Page size, default 25, at most 100.', 'example' => 25],
                'cursor' => ['description' => 'The opaque `meta.next_cursor` of the previous page.', 'example' => 'eyJjb252ZXJzYXRpb25zLmlkIjo0MiwiX3BvaW50c1RvTmV4dEl0ZW1zIjp0cnVlfQ'],
                'format' => ['description' => 'Export only: `csv` (default) or `json`.', 'example' => 'csv'],
            ],
            'Chat\\TransferConversationRequest' => [
                'agent_id' => ['description' => 'Hand the chat to this colleague (user id from `transfer-targets`). Give this or `category`.', 'example' => 7],
                'category' => ['description' => 'Hand the chat to a topic (ulid or slug): it is queued again and offered through the routing waves. Give this or `agent_id`.', 'example' => 'billing'],
            ],
            'Analytics\\AnalyticsRequest' => AnalyticsFieldDocs::request(),
            'Catalog\\StoreCategoryRequest' => self::categoryFields(),
            'Catalog\\UpdateCategoryRequest' => self::categoryFields(),
            'Catalog\\SyncCategoriesRequest' => [
                'category_ulids' => ['description' => 'The complete set, replacing what is there. Every entry must be an existing category.', 'example' => [$category]],
                'category_ulids.*' => ['description' => 'Category ulid.', 'example' => $category],
            ],
            'Catalog\\SyncMyCategoriesRequest' => [
                'category_ulids' => ['description' => 'The complete set of ACTIVE categories the agent serves (replaces the current set).', 'example' => [$category]],
                'category_ulids.*' => ['description' => 'Category ulid.', 'example' => $category],
            ],
            'Widgets\\ReplaceWidgetCategoriesRequest' => [
                'category_ulids' => ['description' => 'The categories enabled on the widget, in display order (replaces the current set).', 'example' => [$category]],
                'category_ulids.*' => ['description' => 'Category ulid.', 'example' => $category],
            ],
            'Agents\\StoreAgentRequest' => [
                'name' => ['description' => 'Display name.', 'example' => 'Sam Rivera'],
                'email' => ['description' => 'Sign-in address; unique.', 'example' => 'sam@example.com'],
                'password' => ['description' => 'Initial password (production requires 12+ characters with mixed case, digits and symbols, not known from breaches).', 'example' => 'correct-Horse-battery-9!'],
                'is_agent' => ['description' => 'Agents always take chats; accepted for forward compatibility.', 'example' => true],
                'category_ulids' => ['description' => 'Categories the agent serves.', 'example' => [$category]],
                'category_ulids.*' => ['description' => 'Category ulid.', 'example' => $category],
            ],
            'Agents\\UpdateAgentRequest' => [
                'max_concurrent_chats' => ['description' => 'Live chats the agent may handle at once (1 to 50).', 'example' => 5],
                'is_active' => ['description' => 'Deactivate or reactivate the account (local mode only; deactivating deletes the person\'s tokens and returns their chats to the queue).', 'example' => true],
                'is_agent' => ['description' => 'Whether the account takes chats (local mode only).', 'example' => true],
            ],
            'Widgets\\StoreWidgetRequest' => [
                'name' => ['description' => 'Name of the new widget. It is created disabled, with the default config.', 'example' => 'Main website'],
            ],
            'Widgets\\UpdateWidgetRequest' => [
                'name' => ['description' => 'Widget name.', 'example' => 'Main website'],
                'is_enabled' => ['description' => 'Disabled widgets answer `404 widget_not_found` on every public endpoint.', 'example' => true],
                'locale' => ['description' => 'Default locale.', 'example' => 'en'],
                'idle_timeout_minutes' => ['description' => 'Minutes without a message before an active chat closes (5 to 10080).', 'example' => 120],
                'queue_timeout_seconds' => ['description' => 'Seconds a chat waits for an agent before it is `missed` (15 to 600).', 'example' => 90],
                'offline_mode' => ['description' => 'Opening hours behaviour.', 'example' => 'auto_hours'],
                'timezone' => ['description' => 'IANA timezone of the opening hours.', 'example' => 'Europe/Berlin'],
                'allow_non_browser_clients' => ['description' => 'Allow requests without an `Origin` header to the public API (servers, native apps).', 'example' => true],
            ],
            'Widgets\\SaveDraftRequest' => [
                'config' => ['description' => 'The complete widget config object (theme, texts, features, hours, routing, pre-chat...). Validated strictly: unknown keys, ranges, colours and URLs are refused with details under `config.*`. Visitors keep seeing the published config until `publish`. The full shape is in `docs/contracts/widget-config.md`.', 'example' => ['defaultLocale' => 'en', 'theme' => ['primary' => '#0ea5e9']]],
            ],
            'Widgets\\ReplaceDomainsRequest' => [
                'domains' => ['description' => 'The complete list of hosts allowed to embed the widget and call the public API from a browser (`host`, `host:port`, `*.host`; an `http://` prefix permits plain http). At most 50.', 'example' => ['example.com', '*.example.org']],
                'domains.*' => ['description' => 'A host entry.', 'example' => 'example.com'],
            ],
            'Widgets\\ReplaceGreetingsRequest' => [
                'greetings' => ['description' => 'The complete greeting pool (at most 100); omitted greetings are deleted.', 'example' => [['body' => 'Hi! Need a hand?', 'agent_name' => 'Sam', 'weight' => 1]]],
                'greetings.*' => ['description' => 'One greeting.'],
                'greetings.*.ulid' => ['description' => 'Ulid of an existing greeting to keep and update; omit for a new one.', 'example' => ExampleValues::ulid('greeting')],
                'greetings.*.body' => ['description' => 'Plain text, at most 2000 characters.', 'example' => 'Hi! Need a hand?'],
                'greetings.*.agent_name' => ['description' => 'Name shown with the greeting.', 'example' => 'Sam'],
                'greetings.*.agent_avatar_url' => ['description' => 'Avatar URL (https).', 'example' => 'https://chat.example.com/storage/avatars/sam.jpg'],
                'greetings.*.locale' => ['description' => 'Only shown to visitors of this locale.', 'example' => 'en'],
                'greetings.*.weight' => ['description' => 'Relative chance of being picked (1 to 100).', 'example' => 1],
                'greetings.*.is_active' => ['description' => 'Whether the greeting is in rotation.', 'example' => true],
                'greetings.*.sort_order' => ['description' => 'Display order in the builder.', 'example' => 0],
            ],
            'Notifications\\UpdateNotificationSettingsRequest' => [
                'sound' => ['description' => 'Play a sound in the dashboard.', 'example' => true],
                'push_offers' => ['description' => 'Push when a chat is offered.', 'example' => true],
                'push_messages' => ['description' => 'Push for new messages.', 'example' => true],
                'include_preview' => ['description' => 'Include message text in pushes (needs the administrator\'s `previewsAllowed`).', 'example' => false],
                'quiet_hours' => ['description' => 'The "do not push me" window, merged field by field into what is saved.'],
                'quiet_hours.enabled' => ['description' => 'Switch the window on.', 'example' => true],
                'quiet_hours.start' => ['description' => '`HH:MM`.', 'example' => '22:00'],
                'quiet_hours.end' => ['description' => '`HH:MM`; with the window on it must differ from `start`.', 'example' => '07:00'],
                'quiet_hours.timezone' => ['description' => 'IANA timezone.', 'example' => 'Europe/Berlin'],
                'prompt_state' => ['description' => 'The answer to the first-login notification dialog. `snoozed` hides it for `snoozeDays` (computed by the server).', 'example' => 'granted'],
            ],
            'Notifications\\StorePushSubscriptionRequest' => [
                'endpoint' => ['description' => 'The browser\'s push endpoint: an https URL of a public host on port 443 (the server posts to it).', 'example' => 'https://fcm.googleapis.com/fcm/send/dZ3tq1Zr0Vc:APA91bH'],
                'keys' => ['description' => 'The subscription keys (`PushSubscription.toJSON().keys`).'],
                'keys.p256dh' => ['description' => 'URL-safe base64 of the 65-byte uncompressed P-256 public key.', 'example' => 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'],
                'keys.auth' => ['description' => 'URL-safe base64 of the 16-byte auth secret.', 'example' => 'tBHItJI5svbpez7KI4CCXg'],
                'expirationTime' => ['description' => 'The subscription\'s expiration time as the browser reports it, or `null`.', 'example' => null],
                'content_encoding' => ['description' => '`aes128gcm` (default) or `aesgcm`.', 'example' => 'aes128gcm'],
            ],
            'Notifications\\RegisterDeviceRequest' => [
                'platform' => ['description' => 'The device platform.', 'example' => 'android'],
                'token' => ['description' => 'The FCM registration token (or APNs-through-FCM token). Stored encrypted; an upsert by the token\'s hash, and a token another member registered moves to the caller.', 'example' => 'fVQk2x0pT5e8z7R1m4N9a3Hc6W0yU2sB5dG8jK1lP4q'],
            ],
            'WhatsApp\\CreateSessionRequest' => [
                'name' => ['description' => '3 to 50 letters, digits and hyphens; unique among live sessions.', 'example' => 'support-line'],
            ],
            'WhatsApp\\UpdateSessionRequest' => [
                'send_min_interval_ms' => ['description' => 'Minimum pause between two sends of this session in milliseconds (0 to 60000); `null` goes back to the global setting.', 'example' => 3000],
                'daily_send_cap' => ['description' => 'Messages per UTC day (1 to 10000); `null` goes back to the global setting.', 'example' => 200],
            ],
            'WhatsApp\\UpdateSettingsRequest' => [
                'enabled' => ['description' => 'Master switch of the visitor-facing side (hand-off, `availability.whatsapp.enabled`). Recording of inbound messages does not depend on it.', 'example' => true],
                'base_url' => ['description' => 'Address of the OpenWA gateway (checked by the outbound address guard). A changed address needs `api_key` in the same request.', 'example' => 'https://openwa.example.com'],
                'api_key' => ['description' => 'Write-only. Printable ASCII without spaces; stored encrypted and never returned.', 'example' => 'owa_live_xxxxxxxxxxxxxxxx'],
                'clear_api_key' => ['description' => 'Remove the stored key.', 'example' => false],
                'handoff_ttl_minutes' => ['description' => 'How long a hand-off code lives.', 'example' => 15],
                'handoff_text' => ['description' => 'The text WhatsApp opens with; it must contain `:code` (one line, at most 200 characters).', 'example' => 'Hi, my chat code is :code'],
                'ignore_groups' => ['description' => 'Do not record group chats.', 'example' => true],
                'reply_only_to_inbound' => ['description' => 'Refuse replies to chats the customer never wrote in.', 'example' => true],
                'send_min_interval_ms' => ['description' => 'Global minimum pause between two sends of one session.', 'example' => 3000],
                'daily_send_cap' => ['description' => 'Global messages per session and UTC day.', 'example' => 200],
                'media_max_bytes' => ['description' => 'Largest image stored.', 'example' => 5242880],
                'retention_days' => ['description' => 'Delete chats and messages older than this (0 = keep for ever).', 'example' => 0],
                'raw_retention_days' => ['description' => 'Drop the raw webhook object kept for debugging after this many days (0 = never kept).', 'example' => 30],
            ],
            'WhatsApp\\ListChatsRequest' => [
                'status' => ['description' => '`open` (default), `archived` or `all` (`all` is the default of the export).', 'example' => 'open'],
                'session' => ['description' => 'Session ulid.', 'example' => ExampleValues::ulid('wa-session')],
                'linked' => ['description' => '`1` only chats a hand-off ticket linked to a visitor, `0` only the others.', 'example' => true],
                'widget' => ['description' => 'Widget ulid.', 'example' => ExampleValues::ulid('widget')],
                'category' => ['description' => 'Category ulid or slug.', 'example' => 'billing'],
                'unread' => ['description' => '`1`: only chats with unread messages.', 'example' => true],
                'q' => ['description' => 'Search: the number, push name, last message, the linked visitor\'s name, e-mail or phone, or the text of any message.', 'example' => 'invoice'],
                'from' => ['description' => 'Export only: messages at or after this instant (a bare date covers the whole day).', 'example' => '2026-09-01'],
                'to' => ['description' => 'Export only: messages at or before this instant.', 'example' => '2026-09-30'],
                'limit' => ['description' => 'Page size, default 50, at most 100.', 'example' => 50],
                'cursor' => ['description' => 'The opaque `meta.next_cursor` of the previous page.', 'example' => 'eyJsYXN0Ijoi...'],
                'format' => ['description' => 'Export only: `csv` (default) or `json`.', 'example' => 'csv'],
                'resource' => ['description' => 'Export only: `messages` (default, one row per message) or `chats`.', 'example' => 'messages'],
            ],
            'WhatsApp\\ListMessagesRequest' => [
                'after_id' => ['description' => 'Message ulid: the page after it (oldest first), the sync call after a reconnect. Not with `before_id`.', 'example' => ExampleValues::ulid('wa-message')],
                'before_id' => ['description' => 'Message ulid: the page before it.', 'example' => ExampleValues::ulid('wa-message')],
                'limit' => ['description' => 'Page size, default 100, at most 200.', 'example' => 100],
            ],
            'WhatsApp\\SendReplyRequest' => [
                'body' => ['description' => 'Plain text, 1 to 4096 characters after cleaning (control and bidi characters are dropped).', 'example' => 'Thanks, we are looking into it.'],
                'client_msg_id' => ['description' => 'Client-made ULID: a repeat returns the original with `200`.', 'example' => '01j9z3q8x7m5n2k4p6r8t0v1w4'],
            ],
            'WhatsApp\\LinkWidgetRequest' => [
                'session' => ['description' => 'Ulid of the WhatsApp session to hand visitors over to, or `null` to unlink. The key itself is required.', 'example' => ExampleValues::ulid('wa-session')],
            ],
        ];
    }

    /**
     * @return array<string, array{description: string, example?: mixed}>
     */
    private static function categoryFields(): array
    {
        return [
            'name' => ['description' => 'Name shown to visitors and agents.', 'example' => 'Billing'],
            'slug' => ['description' => 'URL-safe handle, unique among live categories. Generated from the name when omitted.', 'example' => 'billing'],
            'description' => ['description' => 'One or two lines for the topic picker.', 'example' => 'Questions about invoices, payments and refunds.'],
            'icon' => ['description' => 'Icon name for the topic picker.', 'example' => 'receipt'],
            'color' => ['description' => 'Accent colour (`#rgb`, `#rrggbb` or `#rrggbbaa`).', 'example' => '#0ea5e9'],
            'sort_order' => ['description' => 'Display order (ascending).', 'example' => 10],
            'is_active' => ['description' => 'Inactive categories are hidden from visitors and agents\' pickers.', 'example' => true],
            'name_i18n' => ['description' => 'Translations of the name by locale code (at most 20).', 'example' => ['de' => 'Abrechnung']],
            'name_i18n.*' => ['description' => 'Translated name.', 'example' => 'Abrechnung'],
        ];
    }

    /**
     * @return array<string, array{description: string, example?: mixed, type?: string}>
     */
    public static function for(string $formRequestClass): array
    {
        $key = str_starts_with($formRequestClass, 'App\\Http\\Requests\\') ? substr($formRequestClass, strlen('App\\Http\\Requests\\')) : $formRequestClass;

        return self::all()[$key] ?? [];
    }
}
