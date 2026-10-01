<?php

namespace App\Data\Chat;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The payload of the `chat.offered` event, one per eligible agent (`{v, conversation, category, visitor, preview, widget,
 * wave, expiresAt, ttlSeconds}`): enough for the agent's queue row and OS notification, nothing more. `conversation` is the ulid.
 *
 * `ttlSeconds` is the whole seconds from the moment the payload is built (broadcast / read) until `expiresAt`, never negative: a
 * browser counts down from ITS OWN arrival time instead of comparing `expiresAt` with a clock that may be minutes off.
 */
#[TypeScript]
class OfferData extends Data
{
    public int $v = 1;

    public function __construct(
        public string $conversation,
        public ?CategoryRefData $category,
        public OfferVisitorData $visitor,
        public ?string $preview,
        public WidgetRefData $widget,
        public int $wave,
        public string $expiresAt,
        public int $ttlSeconds,
    ) {}

    /** Eager-load `category`, `visitor` and `widget` on the conversation. */
    public static function fromModel(Conversation $conversation, ConversationOffer $offer): self
    {
        return new self(
            conversation: $conversation->ulid,
            category: $conversation->category === null ? null : CategoryRefData::fromModel($conversation->category),
            visitor: OfferVisitorData::fromModel($conversation->visitor),
            preview: $conversation->last_message_preview,
            widget: WidgetRefData::fromModel($conversation->widget),
            wave: $offer->wave,
            expiresAt: (string) Timestamps::iso($offer->expires_at),
            ttlSeconds: max(0, $offer->expires_at->getTimestamp() - now()->getTimestamp()),
        );
    }
}
