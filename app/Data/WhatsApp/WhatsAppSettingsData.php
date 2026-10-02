<?php

namespace App\Data\WhatsApp;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Settings > WhatsApp as the page shows it. Admin-only. **The API key is write-only**: only `hasApiKey` says one is saved. `enabled` is the
 * master switch of the visitor-facing side (hand-off, `availability.whatsapp.enabled`); the other fields are the `whatsapp.*` settings.
 */
#[TypeScript]
class WhatsAppSettingsData extends Data
{
    public function __construct(
        public bool $enabled,
        public string $baseUrl,
        public bool $hasApiKey,
        public int $handoffTtlMinutes,
        public string $handoffText,
        public bool $ignoreGroups,
        public bool $replyOnlyToInbound,
        public int $sendMinIntervalMs,
        public int $dailySendCap,
        public int $mediaMaxBytes,
    ) {}

    public static function fromSettings(): self
    {
        return new self(
            enabled: settings()->bool('whatsapp.enabled', false),
            baseUrl: settings()->string('whatsapp.openwa.base_url', 'http://127.0.0.1:2785'),
            hasApiKey: settings()->string('whatsapp.openwa.api_key', '') !== '',
            handoffTtlMinutes: settings()->int('whatsapp.handoff_ttl_minutes', 1440),
            handoffText: settings()->string('whatsapp.handoff_text', 'Hi! My support code is :code'),
            ignoreGroups: settings()->bool('whatsapp.ignore_groups', true),
            replyOnlyToInbound: settings()->bool('whatsapp.reply_only_to_inbound', true),
            sendMinIntervalMs: settings()->int('whatsapp.send_min_interval_ms', 1500),
            dailySendCap: settings()->int('whatsapp.daily_send_cap', 200),
            mediaMaxBytes: settings()->int('whatsapp.media_max_bytes', 5 * 1024 * 1024),
        );
    }
}
