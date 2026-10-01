<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Services\ConversationMessenger;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Presence\AvailableAgents;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\DB;

/**
 * The first accept wins (decision P4-D5). The guarded
 * `UPDATE conversations SET status = 'active', assigned_agent_id = :agent ... WHERE id = :id AND status = 'queued' AND assigned_agent_id IS NULL`
 * is the only way a chat becomes active: one affected row = this agent won, zero = somebody else did (`409 already_claimed`).
 *
 * Before the race: the agent must be an active agent who may see the queued chat (an open offer, or an offline ticket of a
 * category they serve), must still serve its category (admins excepted) and, for a live chat, must be under `max_concurrent_chats`
 * (offline tickets take no slot). The capacity check runs inside the transaction after the agent's own row is locked, so two
 * claims of the same agent cannot both slip past it.
 * The winner's offer becomes `accepted`, the others `taken`; a live chat gets the "joined" system line.
 *
 * Accepting a chat that is already YOURS (two tabs, a double click, a retried request) is idempotent: `200` with the conversation,
 * no event and no second "joined" line, even when the agent is at capacity with it. Only a different agent's chat is `already_claimed`.
 *
 * (A Redis `SET NX` could take load off the database; it is deliberately absent: the SQL alone is correct and needs no Redis.)
 */
final class ClaimConversation
{
    public function __construct(
        private readonly ConversationPolicy $policy,
        private readonly AvailableAgents $agents,
        private readonly ConversationMessenger $messenger,
        private readonly ConversationTimeline $timeline,
    ) {}

    public function handle(Conversation $conversation, User $actor): Conversation
    {
        $conversation = Conversation::query()->with(['widget', 'category'])->findOrFail($conversation->id);

        if ($this->isAlreadyTheirs($conversation, $actor)) {
            return $this->loadForResponse($conversation->id);
        }

        $this->authorize($conversation, $actor);

        /** @var array{message: Message|null, taken: list<int>, mine?: bool}|null $result */
        $result = DeadlockRetry::transaction(function () use ($conversation, $actor): ?array {
            // Serialise one agent's claims so the capacity check below cannot be raced by their own parallel accepts.
            User::query()->whereKey($actor->id)->lockForUpdate()->first();

            // A parallel accept of the same agent may have won while this request waited for the lock: that is still a success.
            if ($this->isAlreadyTheirs(Conversation::query()->findOrFail($conversation->id), $actor)) {
                return ['message' => null, 'taken' => [], 'mine' => true];
            }

            // Offline tickets take no slot, so they can be picked up however busy the agent is with live chats.
            if ($conversation->type === ConversationType::Live && $this->agents->activeChats($actor->id) >= max(1, (int) $actor->max_concurrent_chats)) {
                throw ApiProblemException::conflict('at_capacity', __('You are already handling the maximum number of chats.'));
            }

            $takenBy = array_map(intval(...), ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', '!=', $actor->id)
                ->whereNull('responded_at')
                ->pluck('user_id')
                ->all());

            $now = now();
            $live = $conversation->type === ConversationType::Live;

            $claimed = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Queued->value)
                ->whereNull('assigned_agent_id')
                ->update([
                    'status' => ConversationStatus::Active->value,
                    'assigned_agent_id' => $actor->id,
                    'claimed_at' => $now,
                    'claim_version' => DB::raw('claim_version + 1'),
                    'last_activity_at' => $now,
                    'idle_expires_at' => $live ? $now->addMinutes(max(1, (int) $conversation->widget->idle_timeout_minutes)) : null,
                ]);

            if ($claimed === 0) {
                return null;
            }

            ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', $actor->id)
                ->update(['responded_at' => $now, 'response' => OfferResponse::Accepted->value]);
            ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', '!=', $actor->id)
                ->whereNull('responded_at')
                ->update(['responded_at' => $now, 'response' => OfferResponse::Taken->value]);

            $this->timeline->record($conversation, ConversationTimeline::CLAIMED, ActorType::Agent, $actor->id, ['wave' => $conversation->wave]);

            $joined = null;

            if ($live) {
                $locked = Conversation::query()->with('widget')->whereKey($conversation->id)->lockForUpdate()->firstOrFail();
                $joined = $this->messenger->append($locked, SenderType::System, MessageType::System, __(':name joined the chat.', ['name' => $actor->public_label]));
            }

            return ['message' => $joined, 'taken' => $takenBy];
        });

        if ($result === null) {
            // The guarded UPDATE lost; if the winner is this same agent (a parallel accept) the request still succeeds.
            if ($this->isAlreadyTheirs(Conversation::query()->findOrFail($conversation->id), $actor)) {
                return $this->loadForResponse($conversation->id);
            }

            throw $this->lost($conversation->id);
        }

        if (($result['mine'] ?? false) === true) {
            return $this->loadForResponse($conversation->id);
        }

        $fresh = $this->loadForResponse($conversation->id);

        ConversationClaimed::dispatch($fresh, $actor);

        if ($result['taken'] !== []) {
            ChatTaken::dispatch($fresh, $actor, $result['taken']);
        }

        if ($result['message'] instanceof Message) {
            MessageCreated::dispatch($result['message']->load(['conversation.visitor', 'senderUser', 'attachments']));
        }

        QueueChanged::dispatch($fresh);

        return $fresh;
    }

    private function isAlreadyTheirs(Conversation $conversation, User $actor): bool
    {
        return $actor->is_active
            && $actor->is_agent
            && $conversation->status === ConversationStatus::Active
            && $conversation->assigned_agent_id === $actor->id;
    }

    private function loadForResponse(int $conversationId): Conversation
    {
        return Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget'])->findOrFail($conversationId);
    }

    /**
     * Who may take this chat at all. A chat that is no longer queued is `409` for an agent who was offered it (so their client can
     * drop the offer), `403` for anyone else (who learns nothing about it).
     */
    private function authorize(Conversation $conversation, User $actor): void
    {
        if (! $actor->is_active || ! $actor->is_agent) {
            throw ApiProblemException::forbidden('forbidden', __('Only agents can accept chats.'));
        }

        if ($conversation->status !== ConversationStatus::Queued || $conversation->assigned_agent_id !== null) {
            if ($actor->is_admin || ConversationOffer::query()->where('conversation_id', $conversation->id)->where('user_id', $actor->id)->exists()) {
                throw $this->lost($conversation->id);
            }

            throw ApiProblemException::forbidden('forbidden', __('This action is not allowed.'));
        }

        if (! $this->policy->claim($actor, $conversation)) {
            throw ApiProblemException::forbidden('forbidden', __('This chat was not offered to you.'));
        }

        if (! $actor->is_admin && $conversation->category_id !== null && ! $actor->categories()->whereKey($conversation->category_id)->exists()) {
            throw ApiProblemException::forbidden('forbidden', __('You do not serve this topic.'));
        }
    }

    private function lost(int $conversationId): ApiProblemException
    {
        $current = Conversation::query()->with('assignedAgent')->find($conversationId);

        if ($current === null || $current->assignedAgent === null) {
            return ApiProblemException::conflict('conversation_not_queued', __('This chat is no longer waiting for an agent.'));
        }

        // `details.by` is the winner's name (docs/contracts/realtime-events.md), a plain string rather than a list of messages.
        return new ApiProblemException(409, 'already_claimed', __('Another agent already accepted this chat.'), ['by' => $current->assignedAgent->label]);
    }
}
