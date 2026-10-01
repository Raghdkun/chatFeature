<?php

namespace App\Domain\Chat\Support;

use App\Models\Conversation;
use Closure;
use RuntimeException;

/**
 * Short human codes for conversations (`K7M2QX`): the code a visitor reads out to support. Six characters from an
 * alphabet without look-alikes (no I, L, O, 0, 1): about 887 million codes, widened by two characters if a code keeps
 * colliding. The UNIQUE index on `conversations.ticket_no` is the final guard; callers that insert in a race retry.
 */
final class TicketNumberGenerator
{
    public const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

    public const LENGTH = 6;

    /** `conversations.ticket_no` is a varchar(12). */
    public const MAX_LENGTH = 12;

    private const ATTEMPTS_BEFORE_WIDENING = 5;

    private const MAX_ATTEMPTS = 12;

    public static function random(int $length = self::LENGTH): string
    {
        $length = max(1, min($length, self::MAX_LENGTH));
        $max = strlen(self::ALPHABET) - 1;
        $code = '';

        for ($i = 0; $i < $length; $i++) {
            $code .= self::ALPHABET[random_int(0, $max)];
        }

        return $code;
    }

    /**
     * A code no other conversation uses (checked through `$taken`, default: the conversations table).
     *
     * @param  (Closure(string): bool)|null  $taken  Whether a candidate is already in use.
     *
     * @throws RuntimeException When no free code was found (practically impossible with the real alphabet).
     */
    public static function unique(?Closure $taken = null): string
    {
        $taken ??= static fn (string $candidate): bool => Conversation::query()->where('ticket_no', $candidate)->exists();

        for ($attempt = 0; $attempt < self::MAX_ATTEMPTS; $attempt++) {
            $candidate = self::random(self::LENGTH + ($attempt >= self::ATTEMPTS_BEFORE_WIDENING ? 2 : 0));

            if (! $taken($candidate)) {
                return $candidate;
            }
        }

        throw new RuntimeException('Could not generate a free ticket number.');
    }
}
