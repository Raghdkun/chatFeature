<?php

namespace Tests\Feature\Analytics;

use App\Models\Conversation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * "Numbers are being prepared" is for days that had activity and were not rolled up yet; a new installation has nothing to prepare.
 */
class AnalyticsFreshInstallTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = User::factory()->admin()->create();
    }

    /**
     * @return array<string, mixed>
     */
    private function overview(): array
    {
        $from = now()->subDays(30)->format('Y-m-d');
        $to = now()->format('Y-m-d');

        return $this->actingAs($this->admin, 'sanctum')->getJson("/api/v1/analytics/overview?from={$from}&to={$to}")->assertOk()->json('data');
    }

    public function test_an_installation_without_any_chat_has_no_days_to_prepare(): void
    {
        $this->assertSame(0, $this->overview()['meta']['missingDays']);
    }

    public function test_only_the_days_since_the_first_chat_can_be_missing(): void
    {
        config(['analytics.live_fill_days' => 1]);
        Conversation::factory()->create(['created_at' => now()->subDays(5), 'last_activity_at' => now()->subDays(5)]);

        // The first chat was 5 days ago: the day before it (a margin for the time zone) up to yesterday is 6 days, one of them is
        // computed on the spot, five are flagged. Without the floor this would be 30.
        $this->assertSame(5, $this->overview()['meta']['missingDays']);
    }
}
