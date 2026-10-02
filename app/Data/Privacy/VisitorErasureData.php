<?php

namespace App\Data\Privacy;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The answer of `DELETE /visitors/{ulid}`: whether a visitor was erased and what went with them (counts only). A visitor that was not
 * there (already erased, never existed) is `erased: false` with no counts: the call is idempotent.
 */
#[TypeScript]
class VisitorErasureData extends Data
{
    public function __construct(
        public string $visitor,
        public bool $erased,
        public ?int $sessions = null,
        public ?int $conversations = null,
        public ?int $offlineTickets = null,
        public ?int $messages = null,
        public ?int $attachments = null,
        public ?int $ratings = null,
        public ?int $events = null,
        public ?int $whatsappChatsUnlinked = null,
        public ?int $handoffTickets = null,
    ) {}

    /**
     * @param  array<string, int>  $counts
     */
    public static function fromReport(string $visitor, bool $erased, array $counts = []): self
    {
        return new self(
            visitor: $visitor,
            erased: $erased,
            sessions: $counts['sessions'] ?? null,
            conversations: $counts['conversations'] ?? null,
            offlineTickets: $counts['offlineTickets'] ?? null,
            messages: $counts['messages'] ?? null,
            attachments: $counts['attachments'] ?? null,
            ratings: $counts['ratings'] ?? null,
            events: $counts['events'] ?? null,
            whatsappChatsUnlinked: $counts['whatsappChatsUnlinked'] ?? null,
            handoffTickets: $counts['handoffTickets'] ?? null,
        );
    }
}
