<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Presence\PresenceDashboardVisibility;
use App\Domain\Presence\PresenceService;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Tests\TestCase;

class DashboardVisibilityTest extends TestCase
{
    use RefreshDatabase;

    public function test_presence_answers_for_the_notifications_listeners(): void
    {
        $this->assertInstanceOf(PresenceDashboardVisibility::class, app(DashboardVisibility::class));
    }

    public function test_only_a_recent_visible_heartbeat_counts_as_looking(): void
    {
        Carbon::setTestNow('2026-11-20 10:00:00');
        $agent = User::factory()->create(['is_agent' => true, 'is_active' => true]);
        $service = app(PresenceService::class);
        $visibility = app(DashboardVisibility::class);

        $this->assertFalse($visibility->isViewingDashboard($agent->id), 'never signed in');

        $service->set($agent, PresenceStatus::Online, automatic: true);
        $service->heartbeat($agent, visible: true);
        $this->assertTrue($visibility->isViewingDashboard($agent->id));

        Carbon::setTestNow('2026-11-20 10:00:30');
        $service->heartbeat($agent, visible: false);
        $this->assertTrue($visibility->isViewingDashboard($agent->id, 60), 'the visible beat is 30 s old and still within the window');

        Carbon::setTestNow('2026-11-20 10:01:10');
        $service->heartbeat($agent, visible: false);
        $this->assertFalse($visibility->isViewingDashboard($agent->id, 60), 'the tab went to the background more than a minute ago');
        $this->assertTrue($visibility->isViewingDashboard($agent->id, 120));
    }
}
