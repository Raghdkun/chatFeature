<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use Illuminate\Support\Facades\DB;

/**
 * Either side ends an active live chat (decision P4-D8): `active -> ended`, the visitor is asked to rate and has
 * `chat.rating_window_minutes` to do so (`chat:close-unrated` closes it afterwards). A guarded `UPDATE ... WHERE status = 'active'`,
 * so two parties ending at once end it once; the loser gets `409 conversation_not_active`. Offline tickets are never ended
 * (they are closed), and the idle deadline stops with it.
 *
 * Callers authorise first (the visitor owns the chat, or `ConversationAccess::participant`).
 */
final class EndConversation
{
    public function __construct(private readonly ConversationTimeline $timeline) {}

    public function handle(Conversation $conversation, ConversationEndedBy $by, ?int $actorId = null): Conversation
    {
        $window = max(1, settings()->int('chat.rating_window_minutes', 10));

        DB::transaction(function () use ($conversation, $by, $actorId, $window): void {
            $now = now();

            $affected = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Active->value)
                ->where('type', ConversationType::Live->value)
                ->update([
                    'status' => ConversationStatus::Ended->value,
                    'ended_at' => $now,
                    'ended_by' => $by->value,
                    'rating_requested' => true,
                    'rating_window_expires_at' => $now->addMinutes($window),
                    'idle_expires_at' => null,
                ]);

            if ($affected === 0) {
                throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
            }

            $this->timeline->record($conversation, ConversationTimeline::ENDED, $this->actorType($by), $actorId, ['by' => $by->value]);
        });

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id);

        ConversationEnded::dispatch($fresh, $by);

        return $fresh;
    }

    private function actorType(ConversationEndedBy $by): ActorType
    {
        return match ($by) {
            ConversationEndedBy::Visitor => ActorType::Visitor,
            ConversationEndedBy::Agent => ActorType::Agent,
            ConversationEndedBy::Admin => ActorType::Admin,
            ConversationEndedBy::System => ActorType::System,
        };
    }
}
