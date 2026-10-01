<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ConversationRequeuer;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Models\Conversation;
use App\Models\User;

/**
 * An agent who was deactivated or lost the agent role must not keep chats nobody answers (decision P4-D14): every active
 * conversation assigned to them goes back to the queue with fresh offers (to everyone who serves the category except them). The
 * visitor sees "connecting you to another agent". Returns how many chats were re-queued.
 */
final class RequeueAgentConversations
{
    public function __construct(private readonly ConversationRequeuer $requeuer) {}

    public function handle(User $agent, string $reason): int
    {
        $requeued = 0;

        Conversation::query()
            ->where('assigned_agent_id', $agent->id)
            ->where('status', ConversationStatus::Active->value)
            ->orderBy('id')
            ->chunkById(100, function ($conversations) use ($agent, $reason, &$requeued): void {
                foreach ($conversations as $conversation) {
                    $moved = $this->requeuer->requeue(
                        $conversation,
                        $agent->id,
                        null,
                        null,
                        ConversationTimeline::REQUEUED,
                        ActorType::System,
                        null,
                        ['reason' => $reason],
                    );

                    if ($moved === null) {
                        continue;
                    }

                    $requeued++;

                    ConversationTransferred::dispatch($moved, $agent);
                    ConversationQueued::dispatch($moved);
                    QueueChanged::dispatch($moved);
                }
            });

        return $requeued;
    }
}
