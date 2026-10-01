<?php

namespace App\Domain\Chat\Services;

use App\Models\Message;

/** What `SendMessage` returns: the stored message and whether this call created it (false = an idempotent replay). */
final readonly class SentMessage
{
    public function __construct(
        public Message $message,
        public bool $created,
    ) {}
}
