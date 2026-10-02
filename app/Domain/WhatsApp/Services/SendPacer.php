<?php

namespace App\Domain\WhatsApp\Services;

use App\Models\WhatsAppSession;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Support\Facades\Cache;

/**
 * The minimum interval between two sends of one session (`whatsapp.send_min_interval_ms`, a session may override it): the pause that makes
 * a number look like a person instead of a script. Requests are never refused for arriving early: the sending job asks for a slot here and
 * waits for it (a queued job is released for the wait, the `sync` queue sleeps). The slot is "the earliest moment the next send may start",
 * kept in the cache and advanced under a short lock, so two workers never take the same one.
 */
final class SendPacer
{
    /**
     * Take the next slot if it is free now.
     *
     * @return int Milliseconds to wait before this session may send again; 0 = the slot was taken, send now.
     */
    public function acquire(WhatsAppSession $session): int
    {
        $interval = $session->sendMinIntervalMs();

        if ($interval <= 0) {
            return 0;
        }

        $lock = Cache::lock('wa:send-lock:'.$session->id, 5);

        try {
            $lock->block(3);
        } catch (LockTimeoutException) {
            return 1000;
        }

        try {
            $key = 'wa:send-next:'.$session->id;
            $now = (int) now()->getPreciseTimestamp(3);
            $next = (int) Cache::get($key, 0);

            if ($next > $now) {
                return $next - $now;
            }

            Cache::put($key, $now + $interval, (int) ceil($interval / 1000) + 60);

            return 0;
        } finally {
            $lock->release();
        }
    }
}
