<?php

namespace App\Console\Commands;

use App\Auth\Pizzasys\ExternalSessionStore;
use App\Models\ExternalSession;
use Illuminate\Console\Command;

/**
 * Upstream user tokens never expire, so a browser tab that was simply closed would keep a live portal token in
 * `external_sessions` forever. This revokes (and logs out upstream, THAT token only) every session that has not been
 * verified for longer than its own lifetime allows, and deletes long-revoked rows. Scheduled daily.
 */
class ChatAuthPruneSessions extends Command
{
    protected $signature = 'chat:auth:prune-sessions {--keep-days=30 : How long revoked sessions are kept}';

    protected $description = 'Revoke abandoned portal sessions and delete old revoked ones';

    /** Slack on top of a session's lifetime before it counts as abandoned. */
    private const MARGIN_MINUTES = 60;

    public function handle(ExternalSessionStore $sessions): int
    {
        $browserCutoff = now()->subMinutes(max(1, (int) config('session.lifetime', 120)) + self::MARGIN_MINUTES);
        $tokenLifetime = (int) config('sanctum.expiration', 0);
        $tokenCutoff = $tokenLifetime > 0 ? now()->subMinutes($tokenLifetime + self::MARGIN_MINUTES) : null;

        $abandoned = 0;

        ExternalSession::query()
            ->with('environment')
            ->whereNull('revoked_at')
            ->where(function ($query) use ($browserCutoff, $tokenCutoff): void {
                $query->where(fn ($browser) => $browser->whereNull('sanctum_token_id')->where('last_verified_at', '<', $browserCutoff));

                if ($tokenCutoff !== null) {
                    $query->orWhere(fn ($token) => $token->whereNotNull('sanctum_token_id')->where('last_verified_at', '<', $tokenCutoff));
                }
            })
            ->get()
            ->each(function (ExternalSession $session) use ($sessions, &$abandoned): void {
                $sessions->revoke($session, 'expired', upstreamLogout: true);
                $abandoned++;
            });

        $deleted = ExternalSession::query()
            ->whereNotNull('revoked_at')
            ->where('revoked_at', '<', now()->subDays(max(1, (int) $this->option('keep-days'))))
            ->delete();

        $this->components->info("Revoked {$abandoned} abandoned portal session(s); deleted {$deleted} old revoked one(s).");

        return self::SUCCESS;
    }
}
