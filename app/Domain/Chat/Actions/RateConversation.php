<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Chat\Services\MessageText;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\Rating;
use Illuminate\Support\Facades\DB;

/**
 * The visitor rates the chat that ended (`POST /public/conversations/{ulid}/rating`, 1..5 and an optional comment): the rating
 * is stored and the conversation becomes `closed` (`rated`) in one transaction, guarded on `status = 'ended'` and on the rating window
 * (`rating_window_expires_at`, set when the chat ended) so a conversation is rated once and only in time (`409 rating_window_closed`
 * after it, until the per-minute sweep closes the chat as `timeout`). Ratings are visible to administrators only.
 */
final class RateConversation
{
    public function __construct(private readonly ConversationTimeline $timeline) {}

    /** Why the guarded update found nothing: already rated, rated too late (the sweep has not closed it yet), or not ended at all. */
    private function refusal(Conversation $conversation): ApiProblemException
    {
        if (Rating::query()->where('conversation_id', $conversation->id)->exists()) {
            return ApiProblemException::conflict('already_rated', __('You already rated this chat.'));
        }

        return Conversation::query()->whereKey($conversation->id)->first()?->status === ConversationStatus::Ended
            ? ApiProblemException::conflict('rating_window_closed', __('The time to rate this chat is over.'))
            : ApiProblemException::conflict('conversation_not_ended', __('This chat cannot be rated.'));
    }

    public function handle(Conversation $conversation, int $score, ?string $comment): Rating
    {
        $rating = DB::transaction(function () use ($conversation, $score, $comment): Rating {
            $affected = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Ended->value)
                ->where(fn ($window) => $window->whereNull('rating_window_expires_at')->orWhere('rating_window_expires_at', '>', now()))
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::Rated->value,
                    'closed_at' => now(),
                    'rating_requested' => false,
                ]);

            if ($affected === 0) {
                throw $this->refusal($conversation);
            }

            $rating = Rating::query()->create([
                'conversation_id' => $conversation->id,
                'score' => $score,
                'comment' => MessageText::clean($comment),
            ]);

            $this->timeline->record($conversation, ConversationTimeline::RATED, ActorType::Visitor, $conversation->visitor_id, ['score' => $score]);

            return $rating;
        });

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget'])->findOrFail($conversation->id);

        ConversationRated::dispatch($fresh, $rating);
        ConversationClosed::dispatch($fresh, ConversationCloseReason::Rated);

        return $rating->setRelation('conversation', $fresh);
    }
}
