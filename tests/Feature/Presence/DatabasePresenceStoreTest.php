<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use App\Models\AgentPresence;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
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

    public function test_a_deadlock_victim_on_the_first_write_runs_again_instead_of_failing_the_request(): void
    {
        $id = $this->agentId();
        $thrown = 0;

        // Two agents going online at once lock the same gap of the unique index and one of them is chosen as the deadlock victim
        // (MySQL 1213 on the INSERT, found by the e2e suite); the transaction must run again, not become a 500.
        DB::beforeExecuting(function (string $query) use (&$thrown): void {
            if ($thrown < 2 && str_starts_with($query, 'insert into "agent_presence"')) {
                $thrown++;

                $previous = new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction');
                $previous->errorInfo = ['40001', 1213, 'Deadlock found when trying to get lock; try restarting transaction'];

                $exception = new QueryException('mysql', $query, [], $previous);
                $exception->errorInfo = $previous->errorInfo;

                throw $exception;
            }
        });

        $transition = $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));

        $this->assertSame(2, $thrown);
        $this->assertSame(PresenceStatus::Online, $transition->after);
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $id)->sole()->status);
    }
}
