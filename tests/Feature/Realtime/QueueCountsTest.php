<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Realtime\Jobs\BroadcastQueueCounts;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Contracts\Queue\ShouldBeUniqueUntilProcessing;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\RecordingBroadcaster;
use Tests\TestCase;

/**
 * `queue.updated`: each member of staff, and `private-admin`, hears how many queued conversations THEY can see
 * (`Conversation::visibleTo($user)` + `queued`).
 */
class QueueCountsTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase;

    private RecordingBroadcaster $wire;

    protected function setUp(): void
    {
        parent::setUp();

        $this->wire = $this->recordBroadcasts();
    }

    /**
     * The count each channel heard, from the last publish that named it.
     *
     * @return array<string, int>
     */
    private function counts(): array
    {
        $counts = [];

        foreach ($this->wire->of('queue.updated') as $entry) {
            foreach ($entry['channels'] as $channel) {
                $counts[$channel] = $entry['payload']['queued'];
            }
        }

        ksort($counts);

        return $counts;
    }

    public function test_every_audience_gets_the_count_it_can_see(): void
    {
        $billing = Category::factory()->create();
        $alice = User::factory()->agent()->create();
        $bob = User::factory()->agent()->create();
        $carol = User::factory()->agent()->create();
        $admin = User::factory()->admin()->create();
        $bob->categories()->attach($billing->id);

        $offeredToAlice = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offeredToAlice->id, 'user_id' => $alice->id]);
        $offeredToBoth = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offeredToBoth->id, 'user_id' => $alice->id]);
        ConversationOffer::factory()->create(['conversation_id' => $offeredToBoth->id, 'user_id' => $bob->id]);
        Conversation::factory()->offline()->forCategory($billing)->create();
        Conversation::factory()->active($carol)->create();
        Conversation::factory()->closed()->create();

        QueueChanged::dispatch();

        // Three conversations are queued (two live chats, one offline ticket); the active and the closed one do not count.
        $counts = $this->counts();
        $this->assertSame(3, $counts['private-admin']);
        $this->assertSame(3, $counts['private-staff.'.$admin->id]);
        $this->assertSame(2, $counts['private-staff.'.$alice->id], 'two offers');
        $this->assertSame(2, $counts['private-staff.'.$bob->id], 'one offer and the offline ticket of the category they serve');
        $this->assertSame(0, $counts['private-staff.'.$carol->id]);
    }

    public function test_audiences_with_the_same_count_share_one_publish(): void
    {
        $a = User::factory()->agent()->create();
        $b = User::factory()->agent()->create();

        QueueChanged::dispatch();

        $publishes = $this->wire->of('queue.updated');
        $this->assertCount(1, $publishes);
        $this->assertSame(['v' => 1, 'queued' => 0], $publishes[0]['payload']);
        $this->assertEqualsCanonicalizing(['private-admin', 'private-staff.'.$a->id, 'private-staff.'.$b->id], $publishes[0]['channels']);
    }

    public function test_inactive_accounts_and_accounts_without_a_chat_role_are_not_addressed(): void
    {
        $agent = User::factory()->agent()->create();
        $inactive = User::factory()->agent()->inactive()->create();
        $roleless = User::factory()->withoutChatAccess()->create();

        QueueChanged::dispatch();

        $channels = array_keys($this->counts());
        $this->assertContains('private-staff.'.$agent->id, $channels);
        $this->assertNotContains('private-staff.'.$inactive->id, $channels);
        $this->assertNotContains('private-staff.'.$roleless->id, $channels);
    }

    public function test_the_counts_are_read_when_the_job_runs(): void
    {
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $agent->id]);

        QueueChanged::dispatch();
        $this->assertSame(1, $this->counts()['private-staff.'.$agent->id]);

        $this->wire->reset();
        $conversation->forceFill(['status' => 'active', 'assigned_agent_id' => $agent->id])->save();
        ConversationQueued::dispatch($conversation);

        $this->assertSame(0, $this->counts()['private-admin']);
        $this->assertSame(0, $this->counts()['private-staff.'.$agent->id]);
    }

    public function test_a_burst_of_changes_costs_one_job(): void
    {
        Queue::fake();

        QueueChanged::dispatch();
        QueueChanged::dispatch();
        ConversationQueued::dispatch(Conversation::factory()->create());

        Queue::assertPushed(BroadcastQueueCounts::class, 1);
    }

    public function test_the_job_may_run_again_once_it_has_started(): void
    {
        $this->assertSame('realtime-queue-counts', (new BroadcastQueueCounts)->uniqueId());
        $this->assertInstanceOf(ShouldBeUniqueUntilProcessing::class, new BroadcastQueueCounts);

        QueueChanged::dispatch();
        QueueChanged::dispatch();

        $this->assertCount(2, $this->wire->of('queue.updated'), 'with a synchronous queue every change runs its own job');
    }
}
