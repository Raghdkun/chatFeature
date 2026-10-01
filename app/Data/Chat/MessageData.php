<?php

namespace App\Data\Chat;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Message;
use Spatie\LaravelData\Attributes\DataCollectionOf;
use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A chat message exactly as `docs/contracts/realtime-events.md` defines `Message` (REST + `message.created`).
 *
 * `fromModel($message)` is the visitor-safe form (agents appear as `{type, name, avatarUrl}` only, no ids);
 * `fromModel($message, forStaff: true)` adds the sender's staff id. Eager-load `conversation.visitor`, `senderUser` and
 * `attachments` when building lists.
 */
#[TypeScript]
class MessageData extends Data
{
    /**
     * @param  array<int, AttachmentData>  $attachments
     */
    public function __construct(
        public string $ulid,
        public int $seq,
        public string $conversation,
        public MessageSenderData $sender,
        public MessageType $type,
        public ?string $body,
        #[DataCollectionOf(AttachmentData::class)]
        public array $attachments,
        public ?string $clientMsgId,
        public string $createdAt,
        public ?string $deliveredAt,
        public ?string $seenAt,
    ) {}

    public static function fromModel(Message $message, bool $forStaff = false, ?AttachmentUrls $urls = null): self
    {
        $urls ??= app(AttachmentUrls::class);

        return new self(
            ulid: $message->ulid,
            seq: $message->seq,
            conversation: $message->conversation->ulid,
            sender: self::sender($message, $forStaff),
            type: $message->type,
            body: $message->body,
            attachments: $message->attachments->map(fn ($attachment): AttachmentData => AttachmentData::fromModel($attachment, $urls))->all(),
            clientMsgId: $message->client_msg_id,
            createdAt: (string) Timestamps::iso($message->created_at),
            deliveredAt: Timestamps::iso($message->delivered_at),
            seenAt: Timestamps::iso($message->seen_at),
        );
    }

    private static function sender(Message $message, bool $forStaff): MessageSenderData
    {
        return match ($message->sender_type) {
            SenderType::Agent => new MessageSenderData(
                type: SenderType::Agent,
                name: $message->senderUser?->label,
                avatarUrl: $message->senderUser?->avatar_url,
                id: $forStaff && $message->sender_user_id !== null ? $message->sender_user_id : new Optional,
            ),
            SenderType::Visitor => new MessageSenderData(type: SenderType::Visitor, name: $message->conversation->visitor->name, avatarUrl: null),
            SenderType::System => new MessageSenderData(type: SenderType::System, name: null, avatarUrl: null),
        };
    }
}
