<?php

namespace App\Domain\Chat\Services;

use App\Models\Conversation;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Inserts a conversation. The ticket number comes from the model; the UNIQUE index on `ticket_no` has the last word, and a
 * collision is a retry with a new code, not an error (docs/contracts/chat-data-p4.md, rule 6).
 */
final class ConversationCreator
{
    private const ATTEMPTS = 5;

    /**
     * @param  array<string, mixed>  $attributes
     */
    public function create(array $attributes): Conversation
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                // A savepoint inside the caller's transaction: a failed insert must not poison it.
                return DB::transaction(fn (): Conversation => Conversation::query()->create($attributes));
            } catch (UniqueConstraintViolationException $exception) {
                if ($attempt >= self::ATTEMPTS || ! str_contains($exception->getMessage(), 'ticket_no')) {
                    throw $exception;
                }
            }
        }
    }
}
