<?php

namespace App\Data\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\WhatsAppSession;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A WhatsApp session as the settings page shows it. Admin-only. Never carries the webhook secret, the OpenWA API key, the OpenWA ids
 * or the QR image itself: `qrAvailable` says there is one to fetch (`GET .../qr`), `webhookRegistered` that OpenWA was told where to
 * deliver. `linkedWidgetsCount` comes from `withCount('widgets')` when the query loaded it, else from one count query.
 * `sendMinIntervalMs` / `dailySendCap` are the effective pacing values (the session's override, else the setting).
 */
#[TypeScript]
class WhatsAppSessionData extends Data
{
    public function __construct(
        public string $ulid,
        public string $name,
        public string $engine,
        public SessionStatus $status,
        public ?string $phone,
        public ?string $maskedPhone,
        public ?string $pushName,
        public bool $qrAvailable,
        public ?string $lastQrAt,
        public bool $webhookRegistered,
        public string $webhookUrl,
        public ?string $readyAt,
        public ?string $lastError,
        public int $linkedWidgetsCount,
        public bool $isLinkedToWidgets,
        public int $sendMinIntervalMs,
        public int $dailySendCap,
        public bool $pacingOverridden,
        public string $createdAt,
    ) {}

    public static function fromModel(WhatsAppSession $session): self
    {
        $widgets = isset($session->widgets_count) ? (int) $session->widgets_count : $session->widgets()->count();

        return new self(
            ulid: $session->ulid,
            name: $session->name,
            engine: $session->engine,
            status: $session->status,
            phone: $session->phone_e164,
            maskedPhone: $session->maskedPhone(),
            pushName: $session->push_name,
            qrAvailable: $session->hasQr(),
            lastQrAt: Timestamps::iso($session->last_qr_at),
            webhookRegistered: $session->isWebhookRegistered(),
            webhookUrl: $session->webhookUrl(),
            readyAt: Timestamps::iso($session->ready_at),
            lastError: $session->last_error,
            linkedWidgetsCount: $widgets,
            isLinkedToWidgets: $widgets > 0,
            sendMinIntervalMs: $session->sendMinIntervalMs(),
            dailySendCap: $session->dailySendCap(),
            pacingOverridden: isset($session->settings['send_min_interval_ms']) || isset($session->settings['daily_send_cap']),
            createdAt: (string) Timestamps::iso($session->created_at),
        );
    }
}
