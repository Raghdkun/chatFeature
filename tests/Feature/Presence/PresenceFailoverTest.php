<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use App\Domain\Presence\Stores\FailoverPresenceStore;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Tests\Support\FlakyPresenceStore;
use Tests\TestCase;

/** The failure mode of the Redis store in isolation: what `FailoverPresenceStore` does with a primary that cannot be reached. */
class PresenceFailoverTest extends TestCase
{
    use RefreshDatabase;

    private function database(): DatabasePresenceStore
    {
        return new DatabasePresenceStore(new PresencePolicy(90, 5), new PresenceMirror);
    }

    public function test_a_failing_primary_is_answered_by_the_database_one_and_not_asked_again_during_the_cooldown(): void
    {
        Log::spy();
        $this->travelTo(CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC'));
        $primary = FlakyPresenceStore::down($this->database());
        $store = new FailoverPresenceStore($primary, $this->database(), 15);
        $user = User::factory()->agent()->create();

        $choice = $store->choose($user->id, PresenceStatus::Online, true, now());
        $this->assertSame(PresenceStatus::Online, $choice->after);
        $this->assertTrue($choice->changed());
        $this->assertSame(PresenceStatus::Online, $store->find($user->id, now())?->status);
        $this->assertFalse($store->beat($user->id, true, now())->changed());
        $this->assertSame([], $store->staleUserIds(now(), 10));
        $this->assertSame([$user->id], $store->announcedReachableUserIds(0, 10));

        $this->assertSame(1, $primary->calls, 'Redis was tried once, then left alone for the cooldown');
        Log::shouldHaveReceived('warning')->once();

        // After the cooldown Redis is asked again (and fails again: one more warning).
        $this->travel(16)->seconds();
        $store->find($user->id, now());

        $this->assertSame(2, $primary->calls);
        Log::shouldHaveReceived('warning')->twice();
    }

    public function test_a_primary_that_recovers_is_used_again_after_the_cooldown(): void
    {
        Log::spy();
        $this->travelTo(CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC'));
        $primary = FlakyPresenceStore::down($this->database());
        $store = new FailoverPresenceStore($primary, $this->database(), 15);
        $user = User::factory()->agent()->create();

        $store->find($user->id, now());
        $this->assertSame(1, $primary->calls);

        $primary->failure = null;
        $this->travel(5)->seconds();
        $store->find($user->id, now());
        $this->assertSame(1, $primary->calls, 'still inside the cooldown');

        $this->travel(11)->seconds();
        $store->find($user->id, now());
        $store->find($user->id, now());
        $this->assertSame(3, $primary->calls, 'back on the primary');
        Log::shouldHaveReceived('warning')->once();
    }

    public function test_a_failure_that_is_not_an_outage_is_not_swallowed(): void
    {
        $store = new FailoverPresenceStore(new FlakyPresenceStore($this->database(), new RuntimeException('a bug')), $this->database(), 15);

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('a bug');

        $store->find(1, now());
    }

    public function test_a_zero_cooldown_asks_the_primary_every_time(): void
    {
        Log::spy();
        $primary = FlakyPresenceStore::down($this->database());
        $store = new FailoverPresenceStore($primary, $this->database(), 0);

        $store->find(1, now());
        $store->find(1, now());

        $this->assertSame(2, $primary->calls);
    }
}
