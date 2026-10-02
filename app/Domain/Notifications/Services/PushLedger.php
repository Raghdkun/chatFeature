<?php

namespace App\Domain\Notifications\Services;

use Illuminate\Contracts\Cache\Repository;
use Throwable;

/**
 * Remembers WHICH members of staff were pushed a notification (by tag), so the silent `dismiss` that follows only goes to them. An
 * agent who was looking at the dashboard never got the OS notification, and a dismiss would make their browser flash an empty one
 * (browsers insist on a visible notification per push). The markers live in the cache with a TTL; losing one (an eviction, a flushed
 * cache) only means a notification that lingers until it is clicked.
 *
 * Every call is best effort: a cache outage never breaks the event that triggered the push.
 */
final class PushLedger
{
    private const PREFIX = 'push:sent:';

    public function __construct(private readonly Repository $cache) {}

    public function remember(string $tag, int $userId): void
    {
        try {
            $this->cache->put($this->key($tag, $userId), 1, (int) config('push.ledger_ttl_seconds', 3600));
        } catch (Throwable $exception) {
            report($exception);
        }
    }

    /** Whether the user was pushed this tag; forgets the marker (it is used once, by the dismiss). */
    public function pull(string $tag, int $userId): bool
    {
        try {
            return $this->cache->pull($this->key($tag, $userId)) !== null;
        } catch (Throwable $exception) {
            report($exception);

            return false;
        }
    }

    /** Takes a short-lived slot (`$seconds`); false when one is already held: the throttle of a chatty visitor. */
    public function throttle(string $name, int $userId, int $seconds): bool
    {
        if ($seconds <= 0) {
            return true;
        }

        try {
            return $this->cache->add('push:throttle:'.$name.':'.$userId, 1, $seconds);
        } catch (Throwable $exception) {
            report($exception);

            return true;
        }
    }

    private function key(string $tag, int $userId): string
    {
        return self::PREFIX.$tag.':'.$userId;
    }
}
