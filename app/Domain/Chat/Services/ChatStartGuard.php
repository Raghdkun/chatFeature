<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\VisitorSession;
use Illuminate\Support\Facades\Cache;

/**
 * The anti-automation rules around starting a live chat that a per-minute limiter cannot express (the limiters themselves are in
 * `ChatServiceProvider`, numbers in `config/chat.php`). Every start fans an offer out to every reachable agent of the category, so a
 * script that starts and cancels chats in a loop is a notification flood; the Origin check does not stop a non-browser client.
 *
 * - A visitor who cancels a queued chat waits `chat.cancel_cooldown_seconds` before starting another one. It is kept per
 *   VISITOR (not per session), so rotating the token does not skip it.
 * - At most `chat.max_queued_per_network` live chats wait for an agent at once from one client network on one widget (counted
 *   through `visitor_sessions.network_hash`; sessions without one, such as those made by tests, are not counted). It is a soft cap: two
 *   starts at the very same instant can overshoot by one.
 *
 * Both refuse with `429 rate_limited` and `Retry-After`.
 */
final class ChatStartGuard
{
    /** Retry hint (seconds) when the network already has its share of waiting chats: the shortest queue timeout is of that order. */
    private const NETWORK_FULL_RETRY_SECONDS = 30;

    public function startCooldown(int $visitorId): void
    {
        $seconds = (int) config('chat.cancel_cooldown_seconds', 10);

        if ($seconds > 0) {
            Cache::put($this->cooldownKey($visitorId), now()->getTimestamp() + $seconds, $seconds);
        }
    }

    public function assertNotCoolingDown(int $visitorId): void
    {
        $until = Cache::get($this->cooldownKey($visitorId));
        $remaining = is_numeric($until) ? (int) $until - now()->getTimestamp() : 0;

        if ($remaining > 0) {
            throw ApiProblemException::rateLimited(__('Please wait a moment before starting another chat.'), $remaining);
        }
    }

    public function assertNetworkHasRoom(VisitorSession $session): void
    {
        $max = (int) config('chat.max_queued_per_network', 3);

        if ($max < 1 || $session->network_hash === null) {
            return;
        }

        $waiting = Conversation::query()
            ->where('widget_id', $session->widget_id)
            ->where('type', ConversationType::Live->value)
            ->where('status', ConversationStatus::Queued->value)
            ->whereIn('visitor_session_id', VisitorSession::query()
                ->select('id')
                ->where('widget_id', $session->widget_id)
                ->where('network_hash', $session->network_hash))
            ->count();

        if ($waiting >= $max) {
            throw ApiProblemException::rateLimited(__('Too many chats are waiting from your network. Please try again shortly.'), self::NETWORK_FULL_RETRY_SECONDS);
        }
    }

    private function cooldownKey(int $visitorId): string
    {
        return 'chat:cancel-cooldown:'.$visitorId;
    }
}
