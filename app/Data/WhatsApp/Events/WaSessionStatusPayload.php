<?php

namespace App\Data\WhatsApp\Events;

use App\Data\WhatsApp\WhatsAppSessionData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `wa.session.status` on `private-whatsapp-admin`: `{v, session}` after a status change or a new QR (`session.qrAvailable` /
 * `session.lastQrAt` tell the page to fetch it over REST: the QR image itself is never broadcast). Admin-only.
 */
#[TypeScript]
class WaSessionStatusPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public WhatsAppSessionData $session,
    ) {}
}
