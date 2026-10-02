<?php

namespace App\Data\WhatsApp;

use App\Data\Chat\CategoryRefData;
use App\Data\Chat\WidgetRefData;
use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\WaChat;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A recorded WhatsApp chat as a row of the admin inbox. Admin-only (an agent never gets one). `linked` says a hand-off ticket matched it
 * to a widget visitor (`widget` / `category` then name them). Eager-load `session`, `widget` and `category` for lists. Neither the
 * WhatsApp chat id nor any contact detail of a linked visitor is part of it: `WaChatDetailData` adds the latter.
 */
#[TypeScript]
class WaChatData extends Data
{
    public function __construct(
        public string $ulid,
        public WaSessionRefData $session,
        public ?string $phone,
        public ?string $pushName,
        public bool $isGroup,
        public WaChatStatus $status,
        public bool $linked,
        public ?WidgetRefData $widget,
        public ?CategoryRefData $category,
        public int $unreadByAdmin,
        public bool $inboundInitiated,
        public ?string $lastInboundAt,
        public ?string $lastMessageAt,
        public ?string $lastMessagePreview,
        public string $createdAt,
    ) {}

    public static function fromModel(WaChat $chat): self
    {
        return new self(
            ulid: $chat->ulid,
            session: WaSessionRefData::fromModel($chat->session),
            phone: $chat->phone_e164,
            pushName: $chat->push_name,
            isGroup: $chat->is_group,
            status: $chat->status,
            linked: $chat->isLinked(),
            widget: $chat->widget === null ? null : WidgetRefData::fromModel($chat->widget),
            category: $chat->category === null ? null : CategoryRefData::fromModel($chat->category),
            unreadByAdmin: $chat->unread_by_admin,
            inboundInitiated: $chat->inbound_initiated,
            lastInboundAt: Timestamps::iso($chat->last_inbound_at),
            lastMessageAt: Timestamps::iso($chat->last_message_at),
            lastMessagePreview: $chat->last_message_preview,
            createdAt: (string) Timestamps::iso($chat->created_at),
        );
    }
}
