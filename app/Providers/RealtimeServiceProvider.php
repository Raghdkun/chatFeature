<?php

namespace App\Providers;

use App\Domain\Chat\Realtime\AllowedOrigins;
use App\Domain\Chat\Realtime\Listeners\ChatEventSubscriber;
use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Domain\Chat\Realtime\Sockets\ReverbSocketTerminator;
use App\Domain\Chat\Realtime\Sockets\SocketCutOff;
use App\Domain\Chat\Realtime\Sockets\SocketCutOffSubscriber;
use App\Domain\Chat\Realtime\Sockets\SocketTerminator;
use App\Domain\Chat\Realtime\Support\ConversationAudience;
use App\Domain\Chat\Realtime\Support\RedactedReverbBroadcaster;
use App\Domain\Install\InstallState;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Http\Controllers\Api\V1\Public\BroadcastingAuthController;
use App\Models\User;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Throwable;

/**
 * Reverb realtime for the chat (P4, track 4B): the domain events become broadcasts (`ChatEventSubscriber`), the visitor channel
 * authorisation endpoint is rate limited (`broadcasting-auth`), and the Reverb server learns the host the wizard saved.
 *
 * Channel authorisation lives in `routes/channels.php` (+ `App\Domain\Chat\Realtime\Channels`), the Reverb and broadcasting
 * settings in `config/reverb.php` / `config/broadcasting.php`. Nothing here is a hard dependency of REST: see `docs/realtime.md`.
 *
 * The stale-socket cut-off (P7) is wired here too: `SocketCutOffSubscriber` for the domain events, and Eloquent hooks on `User` for
 * every way an account can lose its right to a socket (deactivated, a chat role removed, deleted), whichever code path did it.
 */
class RealtimeServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(ReverbEndpoint::class);
        $this->app->singleton(ConversationAudience::class);
        $this->app->bindIf(SocketTerminator::class, ReverbSocketTerminator::class);
    }

    public function boot(): void
    {
        Event::subscribe(ChatEventSubscriber::class);
        // After the chat subscriber: `session.revoked` is published first, the sockets are closed second.
        Event::subscribe(SocketCutOffSubscriber::class);
        $this->cutOffSocketsOfAccountsThatLoseAccess();

        // The stock `reverb` driver, with failed publishes stripped of their signed URL (see RedactedReverbBroadcaster).
        Broadcast::extend('reverb', fn (Application $app, array $config): RedactedReverbBroadcaster => new RedactedReverbBroadcaster(
            $app->make(BroadcastManager::class)->pusher($config),
            (bool) ($config['jsonp'] ?? false),
        ));

        RateLimiter::for(BroadcastingAuthController::LIMITER, function (Request $request): array {
            $token = $request->bearerToken();
            $limits = [Limit::perMinute((int) config('broadcasting.realtime.auth_rate_limits.per_network', 120))->by('bcast-ip:'.ClientNetwork::bucket($request->ip()))];

            // Keyed by a hash of whatever was sent, before the token is validated: guessing tokens costs the same as using one.
            if ($token !== null && $token !== '') {
                $limits[] = Limit::perMinute((int) config('broadcasting.realtime.auth_rate_limits.per_token', 30))->by('bcast-token:'.hash('sha256', $token));
            }

            return $limits;
        });

        // Reverb compares the Origin HOST of every browser connection with `allowed_origins` (config/reverb.php: APP_URL and
        // REVERB_ALLOWED_ORIGINS, evaluated before the database exists). The URL saved by the setup wizard can differ from
        // APP_URL, so the server process adds it when it starts (a change needs `php artisan reverb:restart`).
        $this->app->booted(function (): void {
            if ($this->app->runningConsoleCommand('reverb:start')) {
                $this->allowSavedAppHost();
            }
        });
    }

    /**
     * A staff account that is deactivated, loses the admin or the agent role, or is deleted loses its websockets: they are closed once the
     * change is committed (the client reconnects and is authorised against the new state). Hooked on the model so every code path counts
     * (the agents API, the auth portal's role resolver, the NATS consumer, a console command).
     */
    private function cutOffSocketsOfAccountsThatLoseAccess(): void
    {
        User::updated(function (User $user): void {
            if (! $user->wasChanged(['is_active', 'is_admin', 'is_agent'])) {
                return;
            }

            $lost = fn (string $attribute): bool => (bool) $user->getOriginal($attribute) && ! $user->{$attribute};

            if ($lost('is_active') || $lost('is_admin') || $lost('is_agent')) {
                $this->cutAfterCommit($user->id, 'role_changed');
            }
        });

        User::deleted(fn (User $user) => $this->cutAfterCommit($user->id, 'deleted'));
    }

    private function cutAfterCommit(int $userId, string $reason): void
    {
        DB::afterCommit(function () use ($userId, $reason): void {
            try {
                $this->app->make(SocketCutOff::class)->cutStaff($userId, $reason);
            } catch (Throwable $exception) {
                report($exception);
            }
        });
    }

    /**
     * Adds the host of the saved `app.url` setting to the origins Reverb accepts (a no-op before the install, or when the setting
     * cannot be read). Called when `reverb:start` boots; public so the server bootstrap can be tested without starting a server.
     */
    public function allowSavedAppHost(): void
    {
        try {
            if (! $this->app->make(InstallState::class)->isInstalled()) {
                return;
            }

            $url = settings()->string('app.url', '');
        } catch (Throwable) {
            return;
        }

        $configured = array_values(array_filter((array) config('reverb.apps.apps.0.allowed_origins', []), 'is_string'));

        config(['reverb.apps.apps.0.allowed_origins' => AllowedOrigins::withAppUrl($configured, $url)]);
    }
}
