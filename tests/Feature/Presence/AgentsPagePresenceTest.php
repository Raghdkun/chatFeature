<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceService;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\UsesPresenceRedis;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The status dots of the agents page: the page carries each staff member's effective status (`presence`: user id => status), read for
 * all of them at once (no query per agent), and agrees with what routing and `GET /me/presence` say.
 */
class AgentsPagePresenceTest extends TestCase
{
    use RefreshDatabase, UsesPresenceRedis, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->configureStore();
        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        $this->travelTo(CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC'));
    }

    protected function tearDown(): void
    {
        if ($this->app !== null && isset($this->presenceUsersToForget)) {
            $this->forgetTrackedPresenceUsers($this->app->make(PresenceStore::class));
        }

        parent::tearDown();
    }

    protected function configureStore(): void
    {
        config(['presence.store' => 'database']);
        $this->resetPresenceServices();
    }

    protected function staff(string $kind = 'agent'): User
    {
        $user = $kind === 'admin' ? User::factory()->admin()->create() : User::factory()->agent()->create();
        $this->trackPresenceUsers($user->id);

        return $user;
    }

    public function test_the_page_carries_the_effective_status_of_every_staff_member(): void
    {
        $admin = $this->staff('admin');
        [$online, $auto, $away, $silent, $never] = [$this->staff(), $this->staff(), $this->staff(), $this->staff(), $this->staff()];
        $service = app(PresenceService::class);

        $service->set($online, PresenceStatus::Online);
        $service->set($admin, PresenceStatus::Online);
        $service->set($auto, PresenceStatus::Online, automatic: true);
        $service->set($away, PresenceStatus::Away);
        $service->set($silent, PresenceStatus::Online);

        // Six minutes of heartbeats from everybody but the silent one; the automatic agent's tab is hidden throughout.
        for ($minute = 1; $minute <= 6; $minute++) {
            $this->travel(60)->seconds();
            $service->heartbeat($online);
            $service->heartbeat($admin);
            $service->heartbeat($away);
            $service->heartbeat($auto, false);
        }

        $this->actingAs($admin)->get('/agents')->assertInertia(fn (Assert $page) => $page
            ->component('agents/index')
            ->where('presence', [
                $admin->id => 'online',
                $online->id => 'online',
                $auto->id => 'away',
                $away->id => 'away',
                $silent->id => 'offline',
                $never->id => 'offline',
            ])
            ->etc());
    }

    public function test_the_page_reads_presence_for_all_agents_at_once(): void
    {
        $admin = $this->staff('admin');
        $service = app(PresenceService::class);
        $countQueries = function () use ($admin): int {
            $count = 0;
            DB::listen(function () use (&$count): void {
                $count++;
            });
            $this->actingAs($admin)->get('/agents')->assertOk();

            return $count;
        };

        $service->set($this->staff(), PresenceStatus::Online);
        $countQueries();
        $few = $countQueries();

        foreach (range(1, 10) as $ignored) {
            $service->set($this->staff(), PresenceStatus::Online);
        }
        $many = $countQueries();

        $this->assertSame($few, $many, 'the number of queries must not grow with the number of agents');
    }

    public function test_only_an_admin_sees_the_agents_page(): void
    {
        $this->actingAs($this->staff())->get('/agents')->assertForbidden();
    }
}
