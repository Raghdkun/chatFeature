<?php

namespace App\Providers;

use App\Domain\Notifications\Channels\FcmChannel;
use App\Domain\Notifications\Channels\WebPushChannel;
use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Notifications\Listeners\ForgetSessionPushSubscriptions;
use App\Domain\Notifications\Listeners\PushEventSubscriber;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Domain\Notifications\Support\PresenceDashboardVisibility;
use App\Domain\Settings\SettingDefinition;
use App\Domain\Settings\SettingGroup;
use App\Domain\Settings\SettingsRegistry;
use App\Domain\Settings\SettingType;
use App\Domain\Widgets\Support\ClientNetwork;
use Illuminate\Auth\Events\Logout;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Push notifications (P5, docs/notifications.md): Web Push now, FCM later (a stub).
 *
 * Owns the push dispatcher and its channels, the listeners that turn the chat's domain events into pushes
 * (`PushEventSubscriber`), the sign-out clean-up of a browser's subscription, the `notifications.push_include_preview` setting and the
 * two push rate limiters. The default
 * `DashboardVisibility` (a fresh presence heartbeat) is bound in `boot()` only when nothing else bound one during `register()`, so
 * the presence context can replace it. Keep bindings and boot logic for this bounded context here so parallel tracks never edit
 * the same provider.
 */
class NotificationsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(PushLedger::class);
        $this->app->singleton(WebPushChannel::class);
        $this->app->singleton(FcmChannel::class);
        $this->app->singleton(PushDispatcher::class, fn ($app): PushDispatcher => new PushDispatcher([
            $app->make(WebPushChannel::class),
            $app->make(FcmChannel::class),
        ]));
    }

    public function boot(): void
    {
        if (! $this->app->bound(DashboardVisibility::class)) {
            $this->app->bind(DashboardVisibility::class, PresenceDashboardVisibility::class);
        }

        $this->app->make(SettingsRegistry::class)->define(
            // The administrator's switch for previews: off, a push never carries text the visitor wrote, whatever staff chose.
            new SettingDefinition('notifications.push_include_preview', SettingGroup::Notifications, SettingType::Bool, true, ['boolean']),
        );

        Event::subscribe(PushEventSubscriber::class);
        Event::listen(Logout::class, ForgetSessionPushSubscriptions::class);

        $this->configureRateLimiting();
    }

    /** Per staff member and minute; the numbers are in `config/push.php`. */
    private function configureRateLimiting(): void
    {
        RateLimiter::for('push-test', fn (Request $request): Limit => Limit::perMinute(max(1, (int) config('push.rate_limits.test_per_minute', 3)))
            ->by('push-test:'.($request->user()?->getAuthIdentifier() ?? ClientNetwork::bucket($request->ip()))));

        RateLimiter::for('push-subscriptions', fn (Request $request): Limit => Limit::perMinute(max(1, (int) config('push.rate_limits.subscriptions_per_minute', 20)))
            ->by('push-subs:'.($request->user()?->getAuthIdentifier() ?? ClientNetwork::bucket($request->ip()))));
    }
}
