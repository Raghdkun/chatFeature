<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use App\Models\AgentPresence;
use Illuminate\Database\DeadlockException;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PDOException;
use Tests\Support\PresenceStoreContract;
use Tests\TestCase;

/** The database store: the contract every store keeps, plus what is special to it (the row is the state; nothing is ever forgotten). */
class DatabasePresenceStoreTest extends TestCase
{
    use PresenceStoreContract, RefreshDatabase;

    protected function makeStore(): PresenceStore
    {
        return new DatabasePresenceStore(new PresencePolicy(90, 5), new PresenceMirror);
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->store = $this->makeStore();
    }

    public function test_the_row_is_the_state_and_carries_what_the_agent_chose(): void
    {
        $id = $this->agentId();

        $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));
        $this->store->beat($id, false, $this->at(45));

        $row = AgentPresence::query()->where('user_id', $id)->sole();
        $this->assertSame(PresenceStatus::Online, $row->status);
        $this->assertFalse($row->is_manual);
        $this->assertSame(PresenceStatus::Online, $row->effective_status);
        $this->assertSame($this->at(45)->getTimestamp(), $row->last_heartbeat_at?->getTimestamp());
        $this->assertSame($this->at(0)->getTimestamp(), $row->last_visible_at?->getTimestamp());
    }

    public function test_a_row_that_nobody_announced_counts_as_the_status_it_implies(): void
    {
        $id = $this->agentId();
        AgentPresence::factory()->create(['user_id' => $id, 'status' => PresenceStatus::Online, 'last_heartbeat_at' => $this->at(0)]);

        // Written by P4 or a test without `effective_status`: a heartbeat finds nothing to announce.
        $this->assertFalse($this->store->beat($id, true, $this->at(30))->changed());
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $id)->sole()->effective_status);
    }

    public function test_it_never_forgets_a_row_so_an_old_tab_can_bring_the_stored_status_back(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $this->store->reconcile($id, $this->at(120));

        $back = $this->store->beat($id, true, $this->at(86_400));

        $this->assertSame(PresenceStatus::Online, $back->after);
        $this->assertSame(PresenceStatus::Online, $this->store->find($id, $this->at(86_401))?->status);
    }

    public function test_a_first_write_that_is_chosen_as_the_deadlock_victim_is_tried_again(): void
    {
        $id = $this->agentId();
        $failures = 0;

        // Two first-time writes for one user: MySQL lets both take the gap lock of the missing row, then one INSERT is rolled back (1213).
        AgentPresence::creating(function () use (&$failures): void {
            $failures++;

            if ($failures === 1) {
                throw new QueryException('mysql', 'insert into `agent_presence`', [], new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction', 40001));
            }
        });

        $transition = $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $this->assertSame(2, $failures);
        $this->assertSame(PresenceStatus::Online, $transition->after);
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $id)->sole()->status);
    }

    public function test_a_write_that_keeps_losing_the_race_gives_up_after_three_tries_and_says_so(): void
    {
        $id = $this->agentId();
        $calls = 0;

        AgentPresence::creating(function () use (&$calls): void {
            $calls++;

            throw new QueryException('mysql', 'insert into `agent_presence`', [], new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction', 40001));
        });

        try {
            $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
            $this->fail('The error must reach the caller.');
        } catch (DeadlockException) {
            $this->assertSame(3, $calls);
        }
    }

    public function test_an_error_that_is_not_a_race_is_not_tried_again(): void
    {
        $id = $this->agentId();
        $calls = 0;

        AgentPresence::creating(function () use (&$calls): void {
            $calls++;

            throw new QueryException('mysql', 'insert into `agent_presence`', [], new PDOException('SQLSTATE[HY000]: General error: 1364 Field has no default value', 1364));
        });

        try {
            $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
            $this->fail('The error must reach the caller.');
        } catch (QueryException) {
            $this->assertSame(1, $calls);
        }
    }
}
