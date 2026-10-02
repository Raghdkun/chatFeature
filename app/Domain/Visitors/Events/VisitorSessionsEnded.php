<?php

namespace App\Domain\Visitors\Events;

use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Visitor sessions (bearer tokens) stopped being valid for good: revoked (sign-out, a chat that moved to a newer token) or capped to the
 * short overlap window of a rotation. Consumed by the realtime layer, which closes the websockets those tokens opened
 * (`SocketCutOffSubscriber`); a natural expiry has no event and is found by `chat:realtime-sweep`.
 */
final class VisitorSessionsEnded implements ShouldDispatchAfterCommit
{
    use Dispatchable;

    /**
     * @param  list<int>  $sessionIds
     */
    public function __construct(
        public readonly array $sessionIds,
        public readonly string $reason,
    ) {}
}
