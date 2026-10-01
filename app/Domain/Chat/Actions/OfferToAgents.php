<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Jobs\ExpireQueuedConversation;
use App\Domain\Chat\Jobs\OfferNextWave;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Chat\Services\RoutingPlan;
use App\Domain\Presence\AvailableAgents;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Routing of a queued live chat to agents (decision P4-D4). One offer row per (conversation, agent); every eligible agent of a
 * wave gets one, the first to accept wins (`ClaimConversation`).
 *
 * `start()` runs wave 1 at once (or after its own delay when the widget configured one), schedules the later waves as delayed
 * jobs and the queue timeout (`ExpireQueuedConversation`); `wave()` is one step and is safe to repeat: an agent who already has a
 * row is never offered the chat twice, and it does nothing once the chat left the queue or its timeout passed.
 */
final class OfferToAgents
{
    public function __construct(
        private readonly AvailableAgents $agents,
        private readonly ConversationTimeline $timeline,
    ) {}

    public function start(Conversation $conversation): void
    {
        if ($conversation->type !== ConversationType::Live) {
            return;
        }

        $plan = RoutingPlan::forWidget($conversation->widget);

        for ($wave = 1; $wave <= $plan->waveCount(); $wave++) {
            $delay = $plan->delayFor($wave);

            if ($delay <= 0) {
                $this->wave($conversation, $wave);
            } else {
                OfferNextWave::dispatch($conversation->id, $wave, now()->addSeconds($delay)->getTimestamp())->delay($delay)->afterCommit();
            }
        }

        ExpireQueuedConversation::schedule($conversation);
    }

    /**
     * Offer the chat to the available agents of wave `$wave` (1-based) that have not been offered it yet. The conversation row is
     * locked while it is checked and the offers are written, so a claim that wins in the meantime is not followed by offers for a
     * chat that is no longer waiting.
     *
     * @return Collection<int, ConversationOffer> the offers made now
     */
    public function wave(Conversation $conversation, int $wave): Collection
    {
        return DB::transaction(function () use ($conversation, $wave): Collection {
            $locked = Conversation::query()->with(['widget', 'category', 'visitor'])->whereKey($conversation->id)->lockForUpdate()->first();

            if ($locked === null
                || $locked->status !== ConversationStatus::Queued
                || $locked->type !== ConversationType::Live
                || $locked->queue_expires_at === null
                || $locked->queue_expires_at->lte(now())) {
                return new Collection;
            }

            $plan = RoutingPlan::forWidget($locked->widget);
            $alreadyOffered = array_values(array_map(intval(...), ConversationOffer::query()->where('conversation_id', $locked->id)->pluck('user_id')->all()));
            $userIds = $this->agents->userIds($locked->category_id, $plan->statusesUpTo($wave), $alreadyOffered);

            Conversation::query()->whereKey($locked->id)->where('wave', '<', $wave)->update(['wave' => $wave]);

            if ($userIds === []) {
                return new Collection;
            }

            $now = now();

            ConversationOffer::query()->insertOrIgnore(array_map(static fn (int $userId): array => [
                'conversation_id' => $locked->id,
                'user_id' => $userId,
                'wave' => $wave,
                'offered_at' => $now,
                'expires_at' => $locked->queue_expires_at,
            ], $userIds));

            $offers = ConversationOffer::query()
                ->where('conversation_id', $locked->id)
                ->where('wave', $wave)
                ->whereIn('user_id', $userIds)
                ->get();

            if ($offers->isNotEmpty()) {
                $this->timeline->record($locked, ConversationTimeline::OFFERED, payload: ['wave' => $wave, 'agents' => $userIds]);
                ChatOffered::dispatch($locked, $offers, $wave, $locked->queue_expires_at);
            }

            return $offers;
        });
    }
}
