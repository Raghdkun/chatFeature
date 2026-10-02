<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use App\Models\AgentPresence;
use Illuminate\Foundation\Testing\RefreshDatabase;
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
}
