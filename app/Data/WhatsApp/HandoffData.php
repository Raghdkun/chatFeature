<?php

namespace App\Data\WhatsApp;

use App\Domain\WhatsApp\Support\WaHandoffUrl;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\WaHandoffTicket;
use LogicException;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The response of the public hand-off call (`POST /api/v1/public/widgets/{key}/whatsapp-handoff`): the code the visitor sends, the
 * `https://wa.me/<number>?text=...` link that opens WhatsApp with it typed in, and when it stops working. VISITOR-FACING: exactly these
 * three keys, nothing about the session, the widget or the ticket's ids.
 */
#[TypeScript]
class HandoffData extends Data
{
    public function __construct(
        public string $code,
        public string $waUrl,
        public string $expiresAt,
    ) {}

    /**
     * @param  string|null  $template  The message text with `:code` in it; the `whatsapp.handoff_text` setting when omitted.
     *
     * @throws LogicException when the ticket's session has no number (it never connected): there is nothing to hand off to
     */
    public static function fromTicket(WaHandoffTicket $ticket, ?string $template = null): self
    {
        $template ??= settings()->string('whatsapp.handoff_text', WaHandoffUrl::DEFAULT_TEXT);
        $url = WaHandoffUrl::build($ticket->session->phone_e164, $template, $ticket->code);

        if ($url === null) {
            throw new LogicException('The WhatsApp session has no connected number to hand visitors over to.');
        }

        return new self(code: $ticket->code, waUrl: $url, expiresAt: (string) Timestamps::iso($ticket->expires_at));
    }
}
