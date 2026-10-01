<?php

namespace App\Domain\Chat\Realtime\Jobs;

use App\Data\Chat\Events\QueueUpdatedPayload;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Realtime\Broadcasts\ImmediatePayloadBroadcast;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Chat\Realtime\Support\ActiveStaff;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Broadcasting\Channel;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUniqueUntilProcessing;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;

/**
 * `queue.updated`: how many queued conversations each member of staff can see, sent to every active staff channel and to
 * `private-admin` (what an audience sees is `Conversation::visibleTo($user)` + `queued`, so an agent counts their own offers and
 * the offline tickets of their categories, an admin counts everything).
 *
 * One job answers every `QueueChanged` / `ConversationQueued` that arrives before it starts (unique until processing): the counts
 * are read when it runs, so a burst of changes costs one round of queries. Staff with the same count share one publish.
 */
final class BroadcastQueueCounts implements ShouldBeUniqueUntilProcessing, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 2;

    public int $timeout = 30;

    /** Safety net for the uniqueness lock when a worker dies before it starts the job. */
    public int $uniqueFor = 15;

    public function __construct()
    {
        $queue = config('broadcasting.realtime.queue');

        if (is_string($queue) && $queue !== '') {
            $this->onQueue($queue);
        }
    }

    public function uniqueId(): string
    {
        return 'realtime-queue-counts';
    }

    public function handle(): void
    {
        /** @var array<int, list<Channel>> $byCount */
        $byCount = [];

        $byCount[$this->queuedFor(null)][] = RealtimeChannels::admin();

        foreach (ActiveStaff::query()->get(['id', 'is_admin', 'is_agent', 'is_active']) as $staff) {
            $byCount[$this->queuedFor($staff)][] = RealtimeChannels::staff($staff->id);
        }

        foreach ($byCount as $queued => $channels) {
            event(new ImmediatePayloadBroadcast(RealtimeEvent::QueueUpdated, $channels, (new QueueUpdatedPayload($queued))->toArray()));
        }
    }

    private function queuedFor(?User $staff): int
    {
        $conversations = $staff === null ? Conversation::query() : Conversation::query()->visibleTo($staff);

        return $conversations->where($conversations->qualifyColumn('status'), ConversationStatus::Queued->value)->count();
    }
}
