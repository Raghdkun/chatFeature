<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use Illuminate\Support\Facades\DB;

/**
 * The visitor declines to rate (`POST /public/conversations/{ulid}/rating/skip`): `ended -> closed` with reason `skipped`.
 */
final class SkipRating
{
    public function __construct(private readonly ConversationTimeline $timeline) {}

    public function handle(Conversation $conversation): Conversation
    {
        DB::transaction(function () use ($conversation): void {
            $affected = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Ended->value)
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::Skipped->value,
                    'closed_at' => now(),
                    'rating_requested' => false,
                ]);

            if ($affected === 0) {
                throw ApiProblemException::conflict('conversation_not_ended', __('This chat cannot be rated.'));
            }

            $this->timeline->record($conversation, ConversationTimeline::CLOSED, ActorType::Visitor, $conversation->visitor_id, ['reason' => ConversationCloseReason::Skipped->value]);
        });

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget'])->findOrFail($conversation->id);

        ConversationClosed::dispatch($fresh, ConversationCloseReason::Skipped);

        return $fresh;
    }
}
