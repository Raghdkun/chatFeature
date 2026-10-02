<?php

namespace App\Data\WhatsApp;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\WaHandoffTicket;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The hand-off ticket that linked a chat, for the chat's detail view: the code the visitor sent and when it was issued and used. */
#[TypeScript]
class WaHandoffRefData extends Data
{
    public function __construct(
        public string $code,
        public string $createdAt,
        public ?string $consumedAt,
    ) {}

    public static function fromModel(WaHandoffTicket $ticket): self
    {
        return new self(
            code: $ticket->code,
            createdAt: (string) Timestamps::iso($ticket->created_at),
            consumedAt: Timestamps::iso($ticket->consumed_at),
        );
    }
}
