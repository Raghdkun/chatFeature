<?php

namespace App\Domain\Chat\Services;

use App\Data\Chat\CategoryRefData;
use App\Data\Chat\TransferAgentData;
use App\Data\Chat\TransferTargetsData;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\AvailableAgents;
use App\Domain\Presence\PresenceService;
use App\Http\Exceptions\ApiProblemException;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;

/**
 * Whether an active LIVE chat can be handed over right now, and the one place that decides it (`TransferConversation` refuses what
 * this rejects with `409 no_agents`; `GET /conversations/{ulid}/transfer-targets` shows the same predicate as `reachable`):
 *
 * - to a colleague: an active agent with presence `online` or `away` (fresh heartbeat) and a free slot (`max_concurrent_chats`);
 * - to a category: at least one such agent who serves it and is offered chats by the widget's routing waves
 *   (`RoutingPlan::allStatuses()`, the rule `StartConversation` and the availability endpoint share), not counting the agent who
 *   lets go of the chat and the person making the transfer.
 *
 * Without this a chat moved to an offline colleague or an empty category would sit in the queue until it became `missed`.
 */
final class TransferTargets
{
    public function __construct(
        private readonly AvailableAgents $agents,
        private readonly PresenceService $presence,
    ) {}

    /** @throws ApiProblemException `409 no_agents` with `details.target = agent` and `details.reason = offline|at_capacity` */
    public function assertAgentReachable(User $agent): void
    {
        if ($this->agents->availableAmong([$agent->id], $this->directStatuses()) !== []) {
            return;
        }

        $status = $this->presence->effectiveStatus(AgentPresence::query()->where('user_id', $agent->id)->first());
        $reason = $status === PresenceStatus::Offline ? 'offline' : 'at_capacity';
        $message = $reason === 'offline'
            ? __('That agent is offline. Choose a colleague who is available.')
            : __('That agent is already handling the maximum number of chats.');

        throw new ApiProblemException(409, 'no_agents', $message, ['target' => 'agent', 'reason' => $reason]);
    }

    /** @throws ApiProblemException `409 no_agents` with `details.target = category` and `details.reason = no_reachable_agent` */
    public function assertCategoryReachable(Conversation $conversation, Category $category, User $actor): void
    {
        if ($this->categoryHasReachableAgent($conversation, $category, $actor)) {
            return;
        }

        throw new ApiProblemException(409, 'no_agents', __('Nobody is available for that topic right now.'), ['target' => 'category', 'reason' => 'no_reachable_agent']);
    }

    public function categoryHasReachableAgent(Conversation $conversation, Category $category, User $actor): bool
    {
        return ($this->categoriesWithReachableAgents($conversation, [$category->id], $actor)[$category->id] ?? 0) > 0;
    }

    /**
     * `GET /conversations/{ulid}/transfer-targets`. The conversation needs its `widget` loaded.
     *
     * @throws ApiProblemException `409 conversation_not_live` for an offline ticket, `409 conversation_not_active` for a chat that is not running
     */
    public function describe(Conversation $conversation, User $caller): TransferTargetsData
    {
        if ($conversation->type !== ConversationType::Live) {
            throw ApiProblemException::conflict('conversation_not_live', __('Only live chats can be transferred.'));
        }

        if ($conversation->status !== ConversationStatus::Active) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        $excluded = $this->excluded($conversation, $caller);

        $candidates = User::query()
            ->where('is_active', true)
            ->where('is_agent', true)
            ->whereNotIn('id', $excluded)
            ->when($conversation->category_id !== null, fn ($query) => $query->whereHas('categories', fn ($categories) => $categories->whereKey($conversation->category_id)))
            ->orderBy('name')
            ->orderBy('id')
            ->get();

        $ids = array_values($candidates->pluck('id')->map(intval(...))->all());
        $presence = AgentPresence::query()->whereIn('user_id', $ids)->get()->keyBy('user_id');
        $loads = $this->agents->activeChatCounts($ids);
        $reachable = array_flip($this->agents->availableAmong($ids, $this->directStatuses()));

        $agents = array_values($candidates->map(fn (User $agent): TransferAgentData => TransferAgentData::fromModel(
            $agent,
            $this->presence->effectiveStatus($presence->get($agent->id)),
            $loads[$agent->id] ?? 0,
            isset($reachable[$agent->id]),
        ))->all());

        $categories = $conversation->widget->categories()
            ->where('categories.is_active', true)
            ->when($conversation->category_id !== null, fn ($query) => $query->whereKeyNot($conversation->category_id))
            ->orderBy('categories.name')
            ->get();
        $counts = $this->categoriesWithReachableAgents($conversation, array_values($categories->pluck('id')->map(intval(...))->all()), $caller);

        return new TransferTargetsData(
            agents: $agents,
            categories: array_values($categories
                ->filter(fn (Category $category): bool => ($counts[$category->id] ?? 0) > 0)
                ->map(fn (Category $category): CategoryRefData => CategoryRefData::fromModel($category))
                ->all()),
        );
    }

    /**
     * @param  list<int>  $categoryIds
     * @return array<int, int> category id => reachable agents
     */
    private function categoriesWithReachableAgents(Conversation $conversation, array $categoryIds, User $actor): array
    {
        $statuses = RoutingPlan::forWidget($conversation->widget)->allStatuses();

        return $this->agents->countByCategory($categoryIds, $statuses, $this->excluded($conversation, $actor));
    }

    /**
     * The agent who lets go of the chat (they are never offered it again) and the person making the transfer.
     *
     * @return list<int>
     */
    private function excluded(Conversation $conversation, User $actor): array
    {
        return array_values(array_unique(array_filter([$conversation->assigned_agent_id, $actor->id])));
    }

    /**
     * @return list<PresenceStatus>
     */
    private function directStatuses(): array
    {
        return [PresenceStatus::Online, PresenceStatus::Away];
    }
}
