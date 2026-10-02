<?php

namespace App\Domain\WhatsApp\Services;

use App\Models\WhatsAppSession;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;

/**
 * The daily send cap of a session (`whatsapp.daily_send_cap`, a session may override it), counted per UTC day in `wa_send_counters`.
 * A guarded `UPDATE ... SET count = count + 1 WHERE count < :cap` is the only way the counter grows, so the cap holds under any number of
 * concurrent replies and survives a cache flush or a restart. A reply takes its slot when it is stored; one that never reached WhatsApp
 * (refused, failed before OpenWA accepted it) gives it back.
 */
final class SendCounter
{
    private const TABLE = 'wa_send_counters';

    /** Take one of today's slots; false when the day's allowance is used up. */
    public function reserve(WhatsAppSession $session, ?CarbonInterface $at = null): bool
    {
        $cap = $session->dailySendCap();
        $day = $this->day($at);

        for ($attempt = 0; $attempt < 4; $attempt++) {
            $row = DB::table(self::TABLE)->where('session_id', $session->id)->where('day', $day);

            if ((clone $row)->where('count', '<', $cap)->increment('count') === 1) {
                return true;
            }

            if ((clone $row)->exists()) {
                return false;
            }

            if ($cap >= 1 && DB::table(self::TABLE)->insertOrIgnore(['session_id' => $session->id, 'day' => $day, 'count' => 1]) === 1) {
                return true;
            }
        }

        return false;
    }

    /** Give a slot back (the reply was never sent), for the day it was taken on. */
    public function release(int $sessionId, CarbonInterface $takenAt): void
    {
        DB::table(self::TABLE)->where('session_id', $sessionId)->where('day', $this->day($takenAt))->where('count', '>', 0)->decrement('count');
    }

    /** How many have been sent today. */
    public function used(WhatsAppSession $session, ?CarbonInterface $at = null): int
    {
        return (int) DB::table(self::TABLE)->where('session_id', $session->id)->where('day', $this->day($at))->value('count');
    }

    /** Seconds until 00:00 UTC, when the allowance starts over. */
    public function secondsUntilReset(): int
    {
        $now = now()->utc();

        return max(1, $now->clone()->addDay()->startOfDay()->getTimestamp() - $now->getTimestamp());
    }

    private function day(?CarbonInterface $at): string
    {
        return ($at?->clone() ?? now())->utc()->toDateString();
    }
}
