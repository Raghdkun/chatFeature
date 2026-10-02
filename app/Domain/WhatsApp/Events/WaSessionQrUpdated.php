<?php

namespace App\Domain\WhatsApp\Events;

use App\Models\WhatsAppSession;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * OpenWA issued a new pairing QR (`$session->last_qr` / `last_qr_at`). Dispatched by the `session.qr` webhook processor and the QR
 * poll (6A); consumed by 6A's broadcast (`wa.session.status`, whose payload only says a QR is available: the image is fetched over REST).
 */
final class WaSessionQrUpdated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly WhatsAppSession $session) {}
}
