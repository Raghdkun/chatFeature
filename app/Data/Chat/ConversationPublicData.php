<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Conversation;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A conversation as its visitor sees it (`ConversationPublic`, docs/contracts/realtime-events.md): the ulid, the human
 * ticket number, status, topic and the agent's public face. No integer ids, no counters, no staff data.
 * Eager-load `category` and `assignedAgent`.
 */
#[TypeScript]
class ConversationPublicData extends Data
{
    public function __construct(
        public string $ulid,
        public string $ticketNo,
        public ConversationStatus $status,
        public ConversationType $type,
        public ?CategoryRefData $category,
        public ?AgentRefData $agent,
        public string $createdAt,
        public ?string $endedAt,
        public bool $ratingRequested,
        public int $lastSeq,
    ) {}

    public static function fromModel(Conversation $conversation): self
    {
        return new self(
            ulid: $conversation->ulid,
            ticketNo: $conversation->ticket_no,
            status: $conversation->status,
            type: $conversation->type,
            category: $conversation->category === null ? null : CategoryRefData::fromModel($conversation->category),
            agent: $conversation->assignedAgent === null ? null : AgentRefData::fromModel($conversation->assignedAgent),
            createdAt: (string) Timestamps::iso($conversation->created_at),
            endedAt: Timestamps::iso($conversation->ended_at),
            ratingRequested: $conversation->rating_requested,
            lastSeq: $conversation->last_seq,
        );
    }
}
