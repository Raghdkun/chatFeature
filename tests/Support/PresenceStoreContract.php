<?php

namespace Tests\Support;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Models\User;
use Carbon\CarbonImmutable;
use Tests\TestCase;

/**
 * What every presence store must do, whatever it keeps its state in (decision P5-D1/D2): run against the database store and, when Redis
 * is reachable, the Redis store. Windows used: 90 s without a heartbeat = offline, 5 minutes of hidden tabs = away.
 *
 * The using class provides `makeStore()`; `setUp` must call `$this->store = $this->makeStore()` after the app exists.
 *
 * @mixin TestCase
 */
trait PresenceStoreContract
{
    protected PresenceStore $store;

    abstract protected function makeStore(): PresenceStore;

    protected function at(int $seconds): CarbonImmutable
    {
        return CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC')->addSeconds($seconds);
    }

    protected function agentId(): int
    {
        $id = User::factory()->agent()->create()->id;

        if (method_exists($this, 'trackPresenceUsers')) {
            $this->trackPresenceUsers($id);
        }

        return $id;
    }

    public function test_a_user_without_a_record_is_unknown_and_a_heartbeat_does_not_create_one(): void
    {
        $id = $this->agentId();

        $this->assertNull($this->store->find($id, $this->at(0)));
        $this->assertSame([], $this->store->findMany([$id], $this->at(0)));

        $beat = $this->store->beat($id, true, $this->at(0));

        $this->assertFalse($beat->changed());
        $this->assertSame(PresenceStatus::Offline, $beat->after);
        $this->assertNull($this->store->find($id, $this->at(1)));
        $this->assertFalse($this->store->reconcile($id, $this->at(2))->changed());
    }

    public function test_choosing_online_creates_the_record_and_the_change_is_reported_once(): void
    {
        $id = $this->agentId();

        $first = $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $this->assertTrue($first->changed());
        $this->assertSame(PresenceStatus::Offline, $first->before);
        $this->assertSame(PresenceStatus::Online, $first->after);
        $this->assertTrue($first->reachabilityChanged());

        $record = $this->store->find($id, $this->at(1));
        $this->assertNotNull($record);
        $this->assertSame(PresenceStatus::Online, $record->status);
        $this->assertTrue($record->manual);
        $this->assertSame($this->at(0)->getTimestamp(), $record->heartbeatAt?->getTimestamp());
        $this->assertSame($this->at(0)->getTimestamp(), $record->visibleAt?->getTimestamp());
        $this->assertSame(PresenceStatus::Online, $record->announced);

        $again = $this->store->choose($id, PresenceStatus::Online, true, $this->at(5));
        $this->assertFalse($again->changed());
    }

    public function test_every_choice_is_a_change_and_offline_leaves_the_last_heartbeat_alone(): void
    {
        $id = $this->agentId();

        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $away = $this->store->choose($id, PresenceStatus::Away, true, $this->at(10));
        $this->assertSame([PresenceStatus::Online, PresenceStatus::Away], [$away->before, $away->after]);
        $this->assertFalse($away->reachabilityChanged());

        $offline = $this->store->choose($id, PresenceStatus::Offline, true, $this->at(20));
        $this->assertSame([PresenceStatus::Away, PresenceStatus::Offline], [$offline->before, $offline->after]);
        $this->assertTrue($offline->reachabilityChanged());

        $record = $this->store->find($id, $this->at(21));
        $this->assertSame(PresenceStatus::Offline, $record?->status);
        $this->assertSame($this->at(10)->getTimestamp(), $record?->heartbeatAt?->getTimestamp());
        $this->assertSame($this->at(20)->getTimestamp(), $record?->seenAt?->getTimestamp());
    }

    public function test_a_heartbeat_refreshes_an_available_agent_and_never_turns_an_offline_one_on(): void
    {
        $id = $this->agentId();

        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $beat = $this->store->beat($id, false, $this->at(30));

        $this->assertFalse($beat->changed());
        $record = $this->store->find($id, $this->at(31));
        $this->assertSame($this->at(30)->getTimestamp(), $record?->heartbeatAt?->getTimestamp());
        $this->assertSame($this->at(0)->getTimestamp(), $record?->visibleAt?->getTimestamp(), 'a hidden tab does not count as visible');

        $this->store->beat($id, true, $this->at(60));
        $this->assertSame($this->at(60)->getTimestamp(), $this->store->find($id, $this->at(61))?->visibleAt?->getTimestamp());

        $this->store->choose($id, PresenceStatus::Offline, true, $this->at(70));
        $off = $this->store->beat($id, true, $this->at(80));

        $this->assertFalse($off->changed());
        $this->assertSame(PresenceStatus::Offline, $off->after);
        $this->assertSame($this->at(60)->getTimestamp(), $this->store->find($id, $this->at(81))?->heartbeatAt?->getTimestamp());
    }

    public function test_a_visible_heartbeat_of_an_agent_who_chose_offline_is_recorded_without_changing_anything_else(): void
    {
        $id = $this->agentId();

        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($id, PresenceStatus::Offline, true, $this->at(10));

        // A hidden tab is not looking: nothing moves but the sign of life.
        $hidden = $this->store->beat($id, false, $this->at(20));
        $this->assertFalse($hidden->changed());
        $record = $this->store->find($id, $this->at(21));
        $this->assertSame(PresenceStatus::Offline, $record?->status);
        $this->assertSame($this->at(0)->getTimestamp(), $record?->visibleAt?->getTimestamp());

        // A visible one is: the dashboard IS open, and the status rules (offline stays offline, the heartbeat time stays) are untouched.
        $visible = $this->store->beat($id, true, $this->at(30));
        $this->assertFalse($visible->changed());
        $this->assertFalse($visible->reachabilityChanged());
        $this->assertSame(PresenceStatus::Offline, $visible->after);
        $record = $this->store->find($id, $this->at(31));
        $this->assertSame(PresenceStatus::Offline, $record?->status);
        $this->assertTrue($record?->manual);
        $this->assertSame($this->at(30)->getTimestamp(), $record?->visibleAt?->getTimestamp());
        $this->assertSame($this->at(0)->getTimestamp(), $record?->heartbeatAt?->getTimestamp(), 'a heartbeat never turns an offline agent on');
    }

    public function test_an_offline_agent_with_the_dashboard_open_keeps_their_record_beyond_the_expiry_of_a_silent_one(): void
    {
        $id = $this->agentId();

        $this->store->choose($id, PresenceStatus::Offline, true, $this->at(0));

        // Beating every 30 s for six minutes (far past the 180 s life of a silent record): the record, and so the pin, is still there.
        for ($seconds = 30; $seconds <= 360; $seconds += 30) {
            $this->store->beat($id, true, $this->at($seconds));
        }

        $record = $this->store->find($id, $this->at(361));
        $this->assertSame(PresenceStatus::Offline, $record?->status);
        $this->assertSame($this->at(360)->getTimestamp(), $record?->visibleAt?->getTimestamp());
    }

    public function test_silence_for_the_window_makes_an_agent_offline_and_the_sweep_announces_it_once(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        // A heartbeat exactly 90 s old still counts; one second more does not.
        $this->assertFalse($this->store->reconcile($id, $this->at(90))->changed());

        $gone = $this->store->reconcile($id, $this->at(91));
        $this->assertSame([PresenceStatus::Online, PresenceStatus::Offline], [$gone->before, $gone->after]);
        $this->assertTrue($gone->reachabilityChanged());

        $this->assertFalse($this->store->reconcile($id, $this->at(92))->changed(), 'idempotent');
        $this->assertFalse($this->store->reconcile($id, $this->at(150))->changed());
        $this->assertSame([], $this->store->staleUserIds($this->at(150), 10));
        $this->assertSame([], $this->store->announcedReachableUserIds(0, 10));
    }

    public function test_a_heartbeat_after_the_sweep_brings_the_agent_back_and_is_announced(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $this->store->reconcile($id, $this->at(100));

        $back = $this->store->beat($id, true, $this->at(120));

        $this->assertSame([PresenceStatus::Offline, PresenceStatus::Online], [$back->before, $back->after]);
        $this->assertFalse($this->store->beat($id, true, $this->at(150))->changed());
    }

    public function test_a_heartbeat_after_silence_nobody_announced_is_no_change(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $beat = $this->store->beat($id, true, $this->at(120));

        $this->assertFalse($beat->changed(), 'clients were never told the agent went offline');
    }

    public function test_an_automatic_agent_goes_away_after_five_hidden_minutes_and_online_again_on_a_visible_beat(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));

        foreach ([60, 120, 180, 240, 299] as $second) {
            $this->assertFalse($this->store->beat($id, false, $this->at($second))->changed(), "hidden for {$second} s");
        }

        $away = $this->store->beat($id, false, $this->at(300));
        $this->assertSame([PresenceStatus::Online, PresenceStatus::Away], [$away->before, $away->after]);
        $this->assertFalse($away->reachabilityChanged());
        $this->assertFalse($this->store->beat($id, false, $this->at(330))->changed());

        $online = $this->store->beat($id, true, $this->at(360));
        $this->assertSame([PresenceStatus::Away, PresenceStatus::Online], [$online->before, $online->after]);
    }

    public function test_the_sweep_moves_an_idle_automatic_agent_to_away_without_a_heartbeat_from_them(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));
        $this->store->beat($id, false, $this->at(80));
        $this->store->beat($id, false, $this->at(160));
        $this->store->beat($id, false, $this->at(240));

        $away = $this->store->reconcile($id, $this->at(300));

        $this->assertSame([PresenceStatus::Online, PresenceStatus::Away], [$away->before, $away->after]);
        $this->assertFalse($this->store->reconcile($id, $this->at(301))->changed());
    }

    public function test_a_pinned_status_wins_over_auto_away(): void
    {
        $online = $this->agentId();
        $away = $this->agentId();
        $this->store->choose($online, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($away, PresenceStatus::Away, true, $this->at(0));

        for ($second = 60; $second <= 1_200; $second += 60) {
            $this->assertFalse($this->store->beat($online, false, $this->at($second))->changed());
            $this->assertFalse($this->store->beat($away, true, $this->at($second))->changed(), 'a visible tab does not turn a pinned away into online');
        }

        $this->assertSame(PresenceStatus::Online, $this->store->reconcile($online, $this->at(1_200))->after);
        $this->assertSame(PresenceStatus::Away, $this->store->reconcile($away, $this->at(1_200))->after);
    }

    public function test_findMany_reads_several_users_at_once(): void
    {
        [$a, $b, $c] = [$this->agentId(), $this->agentId(), $this->agentId()];
        $this->store->choose($a, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($c, PresenceStatus::Away, false, $this->at(0));

        $records = $this->store->findMany([$a, $b, $c], $this->at(1));

        $this->assertEqualsCanonicalizing([$a, $c], array_keys($records));
        $this->assertSame(PresenceStatus::Away, $records[$c]->status);
        $this->assertFalse($records[$c]->manual);
        $this->assertSame([], $this->store->findMany([], $this->at(1)));
    }

    public function test_the_sweep_lists_who_was_announced_reachable_in_id_order_and_in_pages(): void
    {
        [$a, $b, $c, $d] = [$this->agentId(), $this->agentId(), $this->agentId(), $this->agentId()];
        $this->store->choose($c, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($a, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($b, PresenceStatus::Away, true, $this->at(0));
        $this->store->choose($d, PresenceStatus::Offline, true, $this->at(0));

        $this->assertSame([$a, $b, $c], $this->store->announcedReachableUserIds(0, 10));
        $this->assertSame([$a, $b], $this->store->announcedReachableUserIds(0, 2));
        $this->assertSame([$c], $this->store->announcedReachableUserIds($b, 2));
    }

    public function test_forget_drops_everything(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $this->store->forget($id);

        $this->assertNull($this->store->find($id, $this->at(1)));
        $this->assertSame([], $this->store->staleUserIds($this->at(500), 10));
    }
}
