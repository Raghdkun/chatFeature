<?php

namespace App\Support\ApiDocs;

/**
 * The prose of the response fields, by Data class (short name) and property. Types, nullability, enum values and nesting are never
 * written here: {@see DataShape} reads them from the classes. A test pins every entry to an existing property, so a rename cannot
 * leave a stale description behind. Fields that need no explanation are simply not listed.
 */
final class FieldDocs
{
    /**
     * @return array<string, array<string, string>>
     */
    public static function all(): array
    {
        return [
            'ConversationPublicData' => [
                'ulid' => 'Public id of the conversation.',
                'ticketNo' => 'Short ticket number the visitor can quote and staff can search by.',
                'status' => '`queued` (waiting for an agent), `active`, `ended` (the rating window is open), `closed`, `missed` (nobody accepted in time).',
                'type' => '`live` chat or `offline` ticket.',
                'category' => 'The topic the visitor chose; `null` for an offline ticket without one.',
                'agent' => 'The agent\'s public face (name and avatar) once someone accepted; `null` while queued.',
                'createdAt' => 'ISO-8601 UTC with milliseconds.',
                'endedAt' => 'When the chat ended or closed; `null` while it is running.',
                'ratingRequested' => 'True while the rating prompt is open (status `ended` on a widget that rates chats).',
                'lastSeq' => 'Number (`seq`) of the newest message. After a reconnect ask for `after_seq` = the last `seq` you hold.',
            ],
            'ConversationStaffData' => [
                'ulid' => 'Public id of the conversation.',
                'ticketNo' => 'Short ticket number the visitor can quote and staff can search by.',
                'status' => '`queued` (waiting for an agent), `active`, `ended` (the rating window is open), `closed`, `missed` (nobody accepted in time).',
                'type' => '`live` chat or `offline` ticket.',
                'agent' => 'The agent\'s public face as the visitor sees it.',
                'lastSeq' => 'Number (`seq`) of the newest message.',
                'visitor' => 'What the visitor told us (pre-chat form, signed identity, host-site metadata). Staff only.',
                'widget' => 'The widget the visitor chatted on.',
                'assignedAgent' => 'The agent who has the chat (staff view with the user id); `null` while queued.',
                'unseenByAgent' => 'Visitor messages the assigned agent has not read yet (an absolute counter, also pushed as `unread.updated`).',
                'claimedAt' => 'When an agent accepted the chat.',
                'lastMessageAt' => 'Time of the newest message.',
                'lastMessagePreview' => 'Start of the newest message, for list rows.',
                'queueExpiresAt' => 'When a queued live chat becomes `missed`. Count down from this, not from your own clock arithmetic on `createdAt`.',
                'pageUrl' => 'The page the visitor was on when the session started, as the host page reported it (unverified).',
                'pageTitle' => 'Title of that page (unverified).',
            ],
            'VisitorSummaryData' => [
                'ulid' => 'Public id of the visitor (one per signed identity, or per anonymous browser).',
                'verified' => 'True when the identity came from a signed token the host site minted (the claims are authoritative).',
                'meta' => 'Free-form key/value metadata the host site attached (always a JSON object).',
            ],
            'MessageData' => [
                'seq' => 'Per-conversation, monotonic message number: order messages by it and detect gaps with it.',
                'conversation' => 'Ulid of the conversation.',
                'type' => '`text`, `image` (attachments only) or `system` (a line such as "Sam joined the chat.").',
                'body' => 'Plain text (never HTML); `null` for an image-only message.',
                'attachments' => 'Images in the order the sender posted them.',
                'clientMsgId' => 'The client-made ULID the sender attached (idempotency key), echoed back; `null` for server-made lines.',
                'deliveredAt' => 'When the other side\'s client reported receiving the message.',
                'seenAt' => 'When the other side reported reading it.',
            ],
            'MessageSenderData' => [
                'type' => '`visitor`, `agent` or `system`.',
                'name' => 'Display name; `null` for system lines.',
                'id' => 'Staff user id of an agent sender. Present in staff payloads only: for visitors the key is absent.',
            ],
            'AttachmentData' => [
                'url' => 'Short-lived signed URL (`chat.attachment_url_ttl_minutes`, default 240). The signature is the credential: send no `Authorization` header with it and never log it.',
                'thumbUrl' => 'The 320 px thumbnail, signed the same way.',
                'size' => 'Bytes of the stored (re-encoded) image.',
            ],
            'SessionData' => [
                'visitorToken' => 'The visitor bearer token (`vt_` + 40 characters). Shown once; only its sha256 is stored. Keep it out of URLs and logs.',
                'expiresAt' => 'When the token stops working (`chat.visitor_session_ttl_days`).',
                'conversation' => 'The still-open live chat that was resumed with this session, or `null`.',
                'ws' => 'Where to open the websocket (Reverb, Pusher protocol); `null` when realtime is not configured, then stay on REST polling.',
                'limits' => 'The effective limits, for client-side checks. The server enforces them all.',
            ],
            'RealtimeEndpointData' => [
                'key' => 'The public Reverb app key (the Pusher `key`); never a secret.',
                'host' => 'Public host to connect to.',
                'port' => 'Public port.',
                'scheme' => '`https` means `wss://`, `http` means `ws://`.',
            ],
            'SessionLimitsData' => [
                'maxMessageLength' => 'Characters per message.',
                'attachmentMaxBytes' => 'Bytes per image.',
                'attachmentMaxDimension' => 'Longest side of an image in pixels.',
                'attachmentMaxPerMessage' => 'Images one message may carry.',
            ],
            'RatingData' => [
                'conversation' => 'Ulid of the rated conversation.',
                'score' => '1 to 5.',
            ],
            'PresenceData' => [
                'userId' => 'The staff member.',
                'status' => 'The EFFECTIVE status: silence (no heartbeat for 90 s) and auto-away are already applied, exactly as routing reads it.',
                'isManual' => 'True when the agent pinned the status; false when the dashboard/app keeps them `online` while visible and the server moves them to `away` (automatic mode).',
                'lastSeenAt' => 'Time of the last sign of life.',
            ],
            'TransferTargetsData' => [
                'agents' => 'Active agents who serve the chat\'s topic (not the caller, not the current agent).',
                'categories' => 'Topics of the chat\'s widget that currently have a reachable agent.',
            ],
            'TransferAgentData' => [
                'id' => 'Staff user id: the value for `agent_id` of the transfer call.',
                'status' => 'Effective presence.',
                'activeChats' => 'Live chats the colleague is handling right now.',
                'reachable' => 'Exactly what `POST .../transfer` would accept for this colleague at this moment.',
            ],
            'NotificationSettingsData' => [
                'sound' => 'Play a sound in the dashboard for new offers and messages.',
                'pushOffers' => 'Push a notification when a chat is offered.',
                'pushMessages' => 'Push a notification for new messages of the chats the member handles.',
                'includePreview' => 'Include message text in pushes. Ignored while `previewsAllowed` is false.',
                'promptState' => 'Where the member is in the first-login notification dialog.',
                'promptedAt' => 'When the dialog was answered.',
                'snoozedUntil' => '"Not now" hides the dialog until then.',
                'previewsAllowed' => 'The administrator\'s switch (`notifications.push_include_preview`): off, a push never carries visitor text.',
                'pushAvailable' => 'False when the VAPID keys are not configured on the server.',
                'snoozeDays' => 'How long "Not now" hides the dialog.',
            ],
            'QuietHoursData' => [
                'start' => '`HH:MM` wall-clock time in `timezone`; a start after the end runs overnight.',
                'end' => '`HH:MM` wall-clock time in `timezone`.',
                'timezone' => 'IANA timezone name.',
            ],
            'PushSubscriptionData' => [
                'id' => 'Ulid of the subscription row (the value for `DELETE /me/push-subscriptions/{id}`).',
                'host' => 'The push service that receives our pushes.',
                'endpointHash' => 'sha-256 of the endpoint: a browser recognises its own row by hashing its endpoint. The endpoint and keys are never returned.',
            ],
            'PushTestResultData' => [
                'devices' => 'How many of the caller\'s browsers were tried.',
                'sent' => 'Accepted by the push service.',
                'failed' => 'Refused or not reached before the deadline.',
                'removed' => 'Subscriptions the push service said are gone (deleted).',
            ],
            'DeviceTokenData' => [
                'id' => 'Ulid of the registration (the value for `DELETE /me/devices/{id}`). The token itself is never returned.',
                'platform' => '`android` or `ios`.',
            ],
            'AuthUserData' => [
                'id' => 'Staff user id.',
                'avatar' => 'Avatar URL or `null`.',
                'is_admin' => 'May use every admin endpoint.',
                'is_agent' => 'Takes chats.',
                'auth_source' => '`local` (accounts of this installation) or `pizzasys` (accounts of the external auth portal).',
            ],
            'AuthCapabilitiesData' => [
                'canRegister' => 'Self-registration is on (local mode only).',
                'canResetPassword' => 'Password reset by e-mail is available (local mode only).',
                'canManage2fa' => 'The account can manage a second factor (local mode only).',
                'profileEditable' => 'Name and password are edited here (false when the auth portal owns them).',
                'portalUrl' => 'Public label of the auth portal (external mode), else `null`.',
            ],
            'StaffMeData' => [
                'user' => 'The signed-in staff member.',
                'mode' => 'The active auth driver: `fortify` (local accounts) or `pizzasys` (external auth portal).',
                'capabilities' => 'What the active driver lets the user do (hide UI it cannot honour).',
                'token' => 'The bearer token this call was made with; `null` when the call used the dashboard\'s session cookie.',
                'realtime' => 'Where to open the websocket (Laravel Reverb, Pusher protocol) and the public app key; `null` when realtime is not configured, then stay on REST polling. Authorise private channels with `POST /broadcasting/auth` and your bearer token.',
                'serverTime' => 'The server clock (ISO-8601 UTC). Compare it with your own to correct clock skew before counting down any `expiresAt`.',
            ],
            'ApiTokenData' => [
                'id' => 'Token id: the value for `DELETE /auth/tokens/{id}`. It is the number in front of the `|` of the token string.',
                'name' => 'The device name given at sign-in.',
                'abilities' => 'What the token may do. Staff tokens carry `staff`.',
                'lastUsedAt' => 'Last request made with the token.',
                'createdAt' => 'When the token was issued.',
                'expiresAt' => 'When it stops working: issue time + `SANCTUM_EXPIRATION_MINUTES` (default 30 days). Tokens do not slide: sign in again before this.',
                'current' => 'True for the token this call was made with.',
            ],
            'WidgetData' => [
                'ulid' => 'Public id of the widget.',
                'public_key' => '`wk_` + 20 characters: what the embed code and the public API use.',
                'is_enabled' => 'A disabled widget answers `404 widget_not_found` on every public endpoint.',
                'offline_mode' => 'Opening hours behaviour (`hours.mode` of the config).',
                'allow_non_browser_clients' => 'Whether requests without an `Origin` header (servers, native apps) may use the public API.',
                'config_version' => 'Bumped on every publish.',
                'has_identity_secret' => 'Whether signed visitor identities are set up. The secret itself is never returned.',
                'has_unpublished_changes' => 'The draft differs from the published config.',
                'whatsapp_connected' => 'A `ready` WhatsApp session is linked.',
            ],
            'CategoryData' => [
                'slug' => 'URL-safe handle; what the public API takes as `category`.',
                'name_i18n' => 'Translations of the name by locale.',
                'agents_count' => 'Active agents serving it.',
                'widgets_count' => 'Widgets it is enabled on.',
            ],
            'AgentListItemData' => [
                'id' => 'Staff user id.',
                'category_ulids' => 'Categories the agent serves.',
                'max_concurrent_chats' => 'Live chats the agent may handle at once.',
            ],
            'HandoffData' => [
                'code' => 'The 8-character code the visitor sends in WhatsApp.',
                'waUrl' => '`https://wa.me/<number>?text=...`: opens WhatsApp with the code typed in.',
                'expiresAt' => 'When the code stops linking a chat.',
                'ttlSeconds' => 'Whole seconds left when the answer was built. Count down from your own arrival time with this instead of comparing `expiresAt` with the visitor\'s clock.',
            ],
        ] + AnalyticsFieldDocs::fields();
    }

    public static function describe(string $class, string $property): string
    {
        return self::all()[ExampleValues::short($class)][$property] ?? '';
    }
}
