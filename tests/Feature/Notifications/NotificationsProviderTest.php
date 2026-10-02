<?php

namespace Tests\Feature\Notifications;

use App\Domain\Notifications\Channels\FcmChannel;
use App\Domain\Notifications\Channels\WebPushChannel;
use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Support\PresenceDashboardVisibility;
use App\Models\AgentPresence;
use App\Models\User;
use App\Providers\NotificationsServiceProvider;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\FakeDashboardVisibility;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class NotificationsProviderTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    public function test_the_dispatcher_has_the_web_and_the_fcm_channel(): void
    {
        $channels = array_map(fn ($channel): string => $channel::class, app(PushDispatcher::class)->channels());

        $this->assertSame([WebPushChannel::class, FcmChannel::class], $channels);
        $this->assertSame(['web', 'fcm'], array_map(fn ($channel): string => $channel->name(), app(PushDispatcher::class)->channels()));
    }

    public function test_the_default_dashboard_visibility_is_the_presence_based_one(): void
    {
        $this->assertInstanceOf(PresenceDashboardVisibility::class, app(DashboardVisibility::class));
    }

    public function test_a_binding_made_by_another_provider_while_registering_wins_over_the_default(): void
    {
        $fake = new FakeDashboardVisibility;
        $this->refreshApplication();
        $this->app->instance(DashboardVisibility::class, $fake);
        // Boot the provider again: it must leave an existing binding alone.
        (new NotificationsServiceProvider($this->app))->boot();

        $this->assertSame($fake, app(DashboardVisibility::class));
    }

    public function test_the_default_visibility_reads_the_presence_heartbeat(): void
    {
        $visibility = app(DashboardVisibility::class);
        $online = User::factory()->agent()->create();
        $stale = User::factory()->agent()->create();
        $away = User::factory()->agent()->create();
        $offline = User::factory()->agent()->create();
        $never = User::factory()->agent()->create();

        AgentPresence::factory()->online()->create(['user_id' => $online->id]);
        AgentPresence::factory()->online()->create(['user_id' => $stale->id, 'last_heartbeat_at' => now()->subSeconds(75)]);
        AgentPresence::factory()->away()->create(['user_id' => $away->id]);
        AgentPresence::factory()->create(['user_id' => $offline->id, 'last_heartbeat_at' => now()]);

        $this->assertTrue($visibility->isViewingDashboard($online->id, 60));
        $this->assertTrue($visibility->isViewingDashboard($away->id, 60));
        // A heartbeat older than the window does not count (a closed tab, a sleeping laptop)...
        $this->assertFalse($visibility->isViewingDashboard($stale->id, 60));
        // ...unless the caller's window is wider.
        $this->assertTrue($visibility->isViewingDashboard($stale->id, 120));
        $this->assertFalse($visibility->isViewingDashboard($offline->id, 60));
        $this->assertFalse($visibility->isViewingDashboard($never->id, 60));
    }

    public function test_the_include_preview_setting_exists_and_defaults_to_on(): void
    {
        $this->useFortifyMode();

        $this->assertTrue(settings()->bool('notifications.push_include_preview', false));
        settings()->set('notifications.push_include_preview', false);
        $this->assertFalse(settings()->bool('notifications.push_include_preview', true));
    }
}
