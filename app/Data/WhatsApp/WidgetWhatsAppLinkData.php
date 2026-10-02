<?php

namespace App\Data\WhatsApp;

use App\Data\Chat\WidgetRefData;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Models\Widget;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Which WhatsApp session a widget hands visitors over to: `session` (null = none; a deleted session counts as none), its `status` and
 * masked number, and `connected` (a `ready` session is linked). Admin-only. The number itself reaches a visitor only inside the `waUrl`
 * of a hand-off.
 */
#[TypeScript]
class WidgetWhatsAppLinkData extends Data
{
    public function __construct(
        public WidgetRefData $widget,
        public ?WaSessionRefData $session,
        public ?SessionStatus $status,
        public ?string $maskedPhone,
        public bool $connected,
    ) {}

    public static function fromWidget(Widget $widget): self
    {
        $session = $widget->whatsappSession;

        return new self(
            widget: WidgetRefData::fromModel($widget),
            session: $session === null ? null : WaSessionRefData::fromModel($session),
            status: $session?->status,
            maskedPhone: $session?->maskedPhone(),
            connected: $session !== null && $session->isUsable(),
        );
    }
}
