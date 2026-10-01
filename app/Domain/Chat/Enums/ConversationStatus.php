<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Where a conversation is in its life. The one place that knows which moves are legal (plan section 6.3,
 * docs/contracts/chat-data-p4.md):
 *
 * ```text
 * queued -> active | missed | closed        active -> ended | closed | queued (transfer, agent deactivated)
 * ended  -> closed                          missed, closed: terminal
 * ```
 *
 * Writers still use guarded `UPDATE ... WHERE status = :from` statements: this table says what is legal, the SQL
 * makes it race-free. `missed` is terminal: the offline form creates a NEW `type = offline` conversation.
 */
#[TypeScript]
enum ConversationStatus: string
{
    case Queued = 'queued';
    case Active = 'active';
    case Ended = 'ended';
    case Closed = 'closed';
    case Missed = 'missed';

    /**
     * The statuses this one may move to.
     *
     * @return list<self>
     */
    public function allowedTransitions(): array
    {
        return match ($this) {
            self::Queued => [self::Active, self::Missed, self::Closed],
            self::Active => [self::Ended, self::Closed, self::Queued],
            self::Ended => [self::Closed],
            self::Missed, self::Closed => [],
        };
    }

    public function canTransitionTo(self $to): bool
    {
        return in_array($to, $this->allowedTransitions(), true);
    }

    /** Waiting for an agent or being worked on: the statuses that count as "the visitor's open conversation". */
    public function isOpen(): bool
    {
        return in_array($this, self::open(), true);
    }

    /** Nothing can change any more. */
    public function isTerminal(): bool
    {
        return $this->allowedTransitions() === [];
    }

    /**
     * @return list<self>
     */
    public static function open(): array
    {
        return [self::Queued, self::Active];
    }

    /**
     * @return list<string>
     */
    public static function openValues(): array
    {
        return array_map(static fn (self $status): string => $status->value, self::open());
    }
}
