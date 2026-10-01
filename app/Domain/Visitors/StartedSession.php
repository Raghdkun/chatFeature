<?php

namespace App\Domain\Visitors;

use App\Models\Conversation;

/** The outcome of starting a visitor session: the token (plaintext, shown once) and the open chat that was resumed, if any. */
final readonly class StartedSession
{
    public function __construct(
        public IssuedVisitorToken $token,
        public ?Conversation $conversation,
    ) {}
}
