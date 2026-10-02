<?php

namespace App\Data\WhatsApp;

use App\Models\WaChat;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * One WhatsApp chat with what links it to the website: `{chat, visitor, handoff}`. `visitor` and `handoff` are null for a chat no
 * ticket matched. Admin-only. Eager-load what `WaChatData` needs plus `visitor` and `handoffTicket`.
 */
#[TypeScript]
class WaChatDetailData extends Data
{
    public function __construct(
        public WaChatData $chat,
        public ?WaVisitorRefData $visitor,
        public ?WaHandoffRefData $handoff,
    ) {}

    public static function fromModel(WaChat $chat): self
    {
        return new self(
            chat: WaChatData::fromModel($chat),
            visitor: $chat->visitor === null ? null : WaVisitorRefData::fromModel($chat->visitor),
            handoff: $chat->handoffTicket === null ? null : WaHandoffRefData::fromModel($chat->handoffTicket),
        );
    }
}
