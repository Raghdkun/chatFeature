<?php

namespace App\Support\ApiDocs;

/**
 * Deterministic, realistic example values for the response examples (no faker, nothing random): the same input always gives the
 * same output, so a regenerated reference only differs when the API itself changed. Values come from the property's NAME (and the
 * Data class it belongs to); `OVERRIDES` pins the few cases a name cannot decide (`status` of a conversation, an enum's most
 * telling case).
 */
final class ExampleValues
{
    public const CONVERSATION = '01j9z3q8x7m5n2k4p6r8t0v1w2';

    public const MESSAGE = '01j9z3qa4b6c8d0e2f4g6h8jkm';

    private const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

    /** Boolean properties whose typical value is `false` (every other flag reads `true` in the examples). */
    private const FALSE_FLAGS = [
        'ratingRequested', 'isManual', 'is_admin', 'has_unpublished_changes', 'isGroup', 'whatsapp_connected', 'pacingOverridden',
        'qrAvailable', 'allow_non_browser_clients', 'canRegister', 'has_identity_secret',
    ];

    /**
     * `Class short name => [property => example]`, consulted before the generic rules.
     *
     * @var array<string, array<string, mixed>>
     */
    private const OVERRIDES = [
        'ConversationStaffData' => ['status' => 'active', 'unseenByAgent' => 2, 'endedAt' => null, 'queueExpiresAt' => null],
        'ConversationPublicData' => ['status' => 'active', 'endedAt' => null],
        'MessageSenderData' => ['type' => 'agent'],
        'MessageData' => ['seq' => 14, 'type' => 'text', 'deliveredAt' => '2026-09-30T12:04:35.000Z', 'seenAt' => null],
        'ResolvedBootConfigData' => ['v' => 1, 'configVersion' => 3, 'key' => 'wk_k3j9x2m5n8p4q7r1s6t0'],
        'PublicWidgetConfigData' => ['v' => 1],
        'BootApiData' => ['base' => 'https://chat.example.com/api/v1/public', 'embed' => 'https://chat.example.com/embed/wk_k3j9x2m5n8p4q7r1s6t0', 'appOrigin' => 'https://chat.example.com'],
        'ThemeConfigData' => ['primary' => '#0ea5e9', 'primaryText' => '#ffffff', 'accent' => '#f59e0b', 'surface' => '#ffffff', 'text' => '#0f172a', 'fontFamily' => 'Inter, system-ui, sans-serif', 'fontUrl' => null, 'radius' => 16, 'panelWidth' => 380, 'panelHeight' => 640, 'offsetX' => 20, 'offsetY' => 20, 'zIndex' => 2147483000],
        'LauncherConfigData' => ['iconUrl' => null, 'label' => 'Chat with us', 'avatarUrl' => null],
        'GreetingsConfigData' => ['delaySeconds' => 3, 'intervalMinutes' => 30, 'autoHideSeconds' => 12],
        'BootGreetingData' => ['agentName' => 'Sam', 'agentAvatarUrl' => 'https://chat.example.com/storage/avatars/sam.jpg', 'body' => 'Hi! Need a hand?'],
        'HolidayData' => ['date' => '2026-12-25', 'label' => 'Christmas Day'],
        'PreChatConfigData' => ['consentText' => 'I agree that my messages are stored to answer my request.'],
        'ScheduleRangeData' => ['day' => 1, 'start' => '09:00', 'end' => '17:00'],
        'HoursConfigData' => ['timezone' => 'Europe/Berlin'],
        'BootCategoryData' => ['label' => 'Billing'],
        'VisitorSummaryData' => ['ulid' => '01jzms6rf0a56r4jnes8zcwe56'],
        'WaMessageData' => ['status' => 'delivered', 'direction' => 'out'],
        'WaChatData' => ['status' => 'open'],
        'WhatsAppSessionData' => ['status' => 'ready', 'engine' => 'whatsapp-web.js', 'name' => 'support-line'],
        'QuietHoursData' => ['start' => '22:00', 'end' => '07:00', 'timezone' => 'Europe/Berlin'],
        'NotificationSettingsData' => ['promptState' => 'granted'],
        'PresenceData' => ['status' => 'online'],
        'TransferAgentData' => ['status' => 'online'],
        'PresenceMemberData' => ['status' => 'online'],
        'StaffSignInData' => ['token' => '42|8Fq3nT0xKzV7aYc1LwR5pD2mJh6BsU9eGiOtNyXk', 'tokenType' => 'Bearer', 'serverTime' => '2026-09-30T12:00:00.000Z'],
        'StaffTwoFactorChallengeData' => ['challenge' => 'tfc_3vQnK8mZ0pXw2rLd7sYh1cTb5uAe9GjFoR6iNxMk'],
    ];

    /** A 26-character lower-case ULID that is the same for the same seed. */
    public static function ulid(string $seed): string
    {
        $hash = hash('sha256', $seed, true);
        $out = '01j';

        for ($i = 0; strlen($out) < 26; $i++) {
            $out .= self::ALPHABET[ord($hash[$i]) % 32];
        }

        return $out;
    }

    /**
     * The example of a property of a Data class: a pinned override, else a value from its PHP type and name.
     *
     * @param  string  $type  The PHP type name (`string`, `int`, `float`, `bool`).
     */
    public static function for(string $class, string $name, string $type): mixed
    {
        $overrides = self::OVERRIDES[self::short($class)] ?? [];

        if (array_key_exists($name, $overrides)) {
            return $overrides[$name];
        }

        return match ($type) {
            'int' => self::int($name),
            'float' => self::float(),
            'bool' => self::bool($name),
            default => self::string($class, $name),
        };
    }

    /**
     * The example of a string-keyed map property (a JSON object): `{ "plan": "pro" }`.
     */
    public static function map(string $class, string $name, ?string $documented): object
    {
        if ($name === 'name_i18n') {
            return (object) ['de' => 'Abrechnung'];
        }

        if ($name === 'texts') {
            return (object) ['en' => (object) ['title' => 'Chat with us', 'send' => 'Send']];
        }

        if ($name === 'meta') {
            return (object) ['plan' => 'pro'];
        }

        return (object) ['example' => 'example'];
    }

    /**
     * The example for a string-typed property.
     */
    public static function string(string $class, string $name): string
    {
        $short = self::short($class);

        return match (true) {
            $name === 'ulid' => self::entityUlid($short),
            $name === 'conversation' => self::CONVERSATION,
            $name === 'chat' => self::ulid('wa-chat'),
            $name === 'clientMsgId' => self::ulid('client-msg'),
            $name === 'id' => self::ulid($short.'.id'),
            str_ends_with($name, 'Ulid') || str_ends_with($name, '_ulid') => self::ulid($short.'.'.$name),
            $name === 'ticketNo' => 'X4BWQW',
            $name === 'slug' => 'billing',
            $name === 'label' => $short === 'PushSubscriptionData' ? 'Chrome on macOS' : 'Billing',
            $name === 'name' || $name === 'agent_name' => self::personOrThing($short),
            $name === 'pushName' => 'Ada Lovelace',
            $name === 'email' => 'ada@example.com',
            $name === 'phone' || $name === 'maskedPhone' => $name === 'phone' ? '+15551234567' : '+1555***4567',
            $name === 'avatar' || $name === 'avatarUrl' || $name === 'agent_avatar_url' => 'https://chat.example.com/storage/avatars/sam.jpg',
            $name === 'url' => 'https://chat.example.com/api/v1/public/attachments/'.self::ulid('attachment').'?expires=1790000000&signature=4f2a9c',
            $name === 'thumbUrl' => 'https://chat.example.com/api/v1/public/attachments/'.self::ulid('attachment').'?thumb=1&expires=1790000000&signature=7be1d3',
            $name === 'pageUrl' => 'https://example.com/pricing',
            $name === 'pageTitle' => 'Pricing',
            $name === 'webhookUrl' => 'https://chat.example.com/webhooks/openwa/'.self::ulid('wa-session'),
            $name === 'waUrl' => 'https://wa.me/15551234567?text=Hi%2C%20my%20code%20is%20K7M2Q9XA',
            $name === 'baseUrl' => 'https://openwa.example.com',
            $name === 'body' || $name === 'lastMessagePreview' => 'Hello, how can I help you today?',
            $name === 'comment' => 'Quick and helpful, thank you.',
            $name === 'handoffText' => 'Hi, my chat code is :code',
            $name === 'mime' => 'image/jpeg',
            $name === 'filename' => 'photo.jpg',
            $name === 'color' => '#0ea5e9',
            $name === 'icon' => 'message-circle',
            $name === 'description' => 'Questions about invoices, payments and refunds.',
            $name === 'locale' || $name === 'defaultLocale' => 'en',
            $name === 'timezone' => 'Europe/Berlin',
            $name === 'public_key' => 'wk_k3j9x2m5n8p4q7r1s6t0',
            $name === 'visitorToken' => 'vt_eVGMONDGx1TWD1OyZpPnd7Tss5me7zn3q13vHZWb',
            $name === 'code' => 'K7M2Q9XA',
            $name === 'host' => $short === 'PushSubscriptionData' ? 'fcm.googleapis.com' : 'chat.example.com',
            $name === 'scheme' => 'https',
            $name === 'key' => 'f1a2b3c4d5e6f7a8b9c0',
            $name === 'userAgent' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
            $name === 'endpointHash' => hash('sha256', 'push-endpoint'),
            $name === 'platform' => 'android',
            $name === 'engine' => 'whatsapp-web.js',
            $name === 'qr' => 'data:image/png;base64,iVBORw0KGgo...',
            $name === 'auth_source' => 'local',
            $name === 'script' => '<script async src="https://chat.example.com/w/wk_k3j9x2m5n8p4q7r1s6t0.js"></script>',
            $name === 'iframe' => '<iframe src="https://chat.example.com/embed/wk_k3j9x2m5n8p4q7r1s6t0?mode=inline" ...></iframe>',
            $name === 'hosted' => 'https://chat.example.com/c/wk_k3j9x2m5n8p4q7r1s6t0',
            $name === 'php', $name === 'node', $name === 'python' => '// copy-paste code that signs the visitor identity',
            $name === 'reason' => 'unreachable',
            $name === 'message' => 'OpenWA could not be reached.',
            $name === 'role' => 'operator',
            $name === 'lastError' => 'Connection closed by the phone.',
            $name === 'error' => 'The message was not accepted by WhatsApp.',
            $name === 'start' => '22:00',
            $name === 'end' => '07:00',
            str_ends_with($name, 'At') || str_ends_with($name, '_at') || str_ends_with($name, 'Until') || $name === 'waTimestamp' => self::timestamp($name),
            default => 'example',
        };
    }

    /** The example for an integer-typed property. */
    public static function int(string $name): int
    {
        return match (true) {
            $name === 'id' || $name === 'userId' => 7,
            $name === 'seq' || $name === 'lastSeq' || $name === 'upToSeq' => 14,
            $name === 'size' => 48213,
            $name === 'width' => 1280,
            $name === 'height' => 720,
            $name === 'port' => 443,
            $name === 'score' => 5,
            $name === 'ttlSeconds' => 540,
            $name === 'max_concurrent_chats' || $name === 'maxConcurrentChats' => 5,
            $name === 'maxMessageLength' => 4000,
            $name === 'attachmentMaxBytes' || $name === 'mediaMaxBytes' => 5242880,
            $name === 'attachmentMaxDimension' => 4096,
            $name === 'attachmentMaxPerMessage' => 5,
            $name === 'snoozeDays' => 7,
            $name === 'handoffTtlMinutes' => 15,
            $name === 'sendMinIntervalMs' => 3000,
            $name === 'dailySendCap' => 200,
            $name === 'retentionDays', $name === 'rawRetentionDays' => 30,
            $name === 'config_version' => 3,
            $name === 'idle_timeout_minutes' => 120,
            $name === 'queue_timeout_seconds' => 90,
            $name === 'sort_order' || $name === 'weight' => 1,
            default => 3,
        };
    }

    public static function float(): float
    {
        return 1.5;
    }

    public static function timestamp(string $name): string
    {
        $time = match (true) {
            str_contains($name, 'claimed') => '12:00:18',
            str_contains($name, 'lastMessage') => '12:04:31',
            str_contains($name, 'ended') => '12:12:09',
            str_contains($name, 'expires') || str_contains($name, 'Until') => '12:30:00',
            str_contains($name, 'lastSeen') || str_contains($name, 'last_seen') => '12:04:50',
            default => '12:00:00',
        };

        return '2026-09-30T'.$time.'.000Z';
    }

    /** The example for a boolean property. */
    public static function bool(string $name): bool
    {
        return ! in_array($name, self::FALSE_FLAGS, true);
    }

    public static function short(string $class): string
    {
        $position = strrpos($class, '\\');

        return $position === false ? $class : substr($class, $position + 1);
    }

    private static function entityUlid(string $short): string
    {
        return match (true) {
            str_starts_with($short, 'Conversation') => self::CONVERSATION,
            str_starts_with($short, 'Message') => self::MESSAGE,
            str_contains($short, 'Visitor') => self::ulid('visitor'),
            str_starts_with($short, 'Widget') => self::ulid('widget'),
            str_starts_with($short, 'Category') => self::ulid('category'),
            str_starts_with($short, 'WaChat') => self::ulid('wa-chat'),
            str_starts_with($short, 'WaMessage') => self::ulid('wa-message'),
            str_starts_with($short, 'WhatsAppSession') || str_starts_with($short, 'WaSession') => self::ulid('wa-session'),
            default => self::ulid($short),
        };
    }

    private static function personOrThing(string $short): string
    {
        return match (true) {
            str_contains($short, 'Visitor') => 'Ada Lovelace',
            str_starts_with($short, 'Widget') => 'Main website',
            str_starts_with($short, 'Category') => 'Billing',
            str_starts_with($short, 'WhatsAppSession'), str_starts_with($short, 'WaSession') => 'support-line',
            str_starts_with($short, 'Greeting') => 'Sam',
            default => 'Sam Rivera',
        };
    }
}
