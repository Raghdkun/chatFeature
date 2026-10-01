<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Domain\Chat\Enums\SenderType;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * STUB of track 4A so the typing endpoints can dispatch and be tested before the realtime backend is merged: the orchestrator keeps
 * track 4B's version of this file (same path, same constructor), which publishes `typing` on `private-conversation.{ulid}`.
 * Dispatched by `POST .../typing` after the caller was authorised: `TypingBroadcast::dispatch($conversation->ulid, SenderType::Visitor, true)`.
 */
final class TypingBroadcast
{
    use Dispatchable;

    public function __construct(
        public readonly string $conversation,
        public readonly SenderType $actor,
        public readonly bool $typing,
    ) {}
}
