<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ConversationAccess;
use App\Domain\Chat\Services\ConversationRequeuer;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Chat\Services\TransferTargets;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Validation\ValidationException;

/**
 * The agent (or an admin) hands an active chat to a colleague or to another category (`POST /conversations/{ulid}/transfer`).
 * The chat goes back to `queued` with the assignee cleared and the history kept in `conversation_events`
 * (`ConversationRequeuer`): a transfer to a category is offered through the routing waves, to everyone who serves it except the
 * agent who let go; a transfer to a colleague offers it to that agent alone. The colleague must be an active agent who serves the
 * chat's category (they accept it like any other offer); the category must be active and enabled on the chat's widget.
 *
 * A LIVE chat is only handed to somebody who can take it right now (`TransferTargets`): an online / away colleague below their
 * capacity, or a category with at least one such agent. Otherwise `409 no_agents` (`details.target`, `details.reason`) and the
 * agent keeps the chat.
 */
final class TransferConversation
{
    public function __construct(
        private readonly ConversationAccess $access,
        private readonly ConversationRequeuer $requeuer,
        private readonly TransferTargets $targets,
    ) {}

    public function handle(Conversation $conversation, User $actor, ?User $toAgent, ?Category $toCategory): Conversation
    {
        $conversation = Conversation::query()->with(['widget', 'assignedAgent'])->findOrFail($conversation->id);

        $this->access->participant($actor, $conversation);

        if ($conversation->status !== ConversationStatus::Active) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        if (($toAgent === null) === ($toCategory === null)) {
            throw ValidationException::withMessages(['agent_id' => [__('Choose either a colleague or a category.')]]);
        }

        if ($toAgent !== null) {
            $this->assertCanReceive($conversation, $toAgent);
        }

        if ($toCategory !== null) {
            $this->assertCategoryUsable($conversation, $toCategory);
        }

        // A live chat is only handed to somebody who can take it now (else it would sit in the queue until it is `missed`): the
        // transferring agent keeps the chat when nobody can. Offline tickets are found by category and wait for whoever comes.
        if ($conversation->type === ConversationType::Live) {
            if ($toAgent !== null) {
                $this->targets->assertAgentReachable($toAgent);
            }

            if ($toCategory !== null) {
                $this->targets->assertCategoryReachable($conversation, $toCategory, $actor);
            }
        }

        $fromAgent = $conversation->assignedAgent;
        $moved = $this->requeuer->requeue(
            $conversation,
            $conversation->assigned_agent_id,
            $toCategory,
            $toAgent,
            ConversationTimeline::TRANSFERRED,
            $actor->is_admin && $actor->id !== $conversation->assigned_agent_id ? ActorType::Admin : ActorType::Agent,
            $actor->id,
        );

        if ($moved === null) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat changed in the meantime.'));
        }

        ConversationTransferred::dispatch($moved, $fromAgent, $toAgent, $toCategory);

        if ($toAgent !== null) {
            ConversationAssigned::dispatch($moved, $toAgent, $actor, $fromAgent);
        }

        ConversationQueued::dispatch($moved);
        QueueChanged::dispatch($moved);

        return $moved;
    }

    private function assertCanReceive(Conversation $conversation, User $agent): void
    {
        if ($agent->id === $conversation->assigned_agent_id) {
            throw ValidationException::withMessages(['agent_id' => [__('This chat is already assigned to that agent.')]]);
        }

        $serves = $conversation->category_id === null || $agent->categories()->whereKey($conversation->category_id)->exists();

        if (! $agent->is_active || ! $agent->is_agent || ! $serves) {
            throw ValidationException::withMessages(['agent_id' => [__('That agent cannot take this chat.')]]);
        }
    }

    private function assertCategoryUsable(Conversation $conversation, Category $category): void
    {
        $usable = $category->is_active && $conversation->widget->categories()->whereKey($category->id)->exists();

        if (! $usable) {
            throw ValidationException::withMessages(['category' => [__('This topic is not available.')]]);
        }
    }
}
