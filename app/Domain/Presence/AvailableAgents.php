<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\PresenceStatus;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Which agents can take a new chat right now: the one definition routing (offers), the claim action and the public
 * availability endpoint share, so "online" means the same thing everywhere.
 *
 * An agent is available when the account is active and takes chats (`is_agent`), serves the category, has an EFFECTIVE presence status
 * in the asked set (the presence store through `EffectivePresence`: silence and auto-away included, so an auto-away agent is `away` here
 * exactly as `GET /me/presence` says), and has fewer active LIVE chats than `max_concurrent_chats` (offline tickets do not occupy a slot).
 * SQL picks the candidates (account, category, capacity); one batch read of the store decides who of them has the asked status.
 */
final class AvailableAgents
{
    public function __construct(private readonly EffectivePresence $presence) {}

    /**
     * @param  list<PresenceStatus>  $statuses
     * @param  list<int>  $excludeUserIds
     * @return list<int> user ids
     */
    public function userIds(?int $categoryId, array $statuses, array $excludeUserIds = []): array
    {
        if ($statuses === []) {
            return [];
        }

        $query = $this->candidates()->select('users.id')->distinct();

        if ($categoryId !== null) {
            $query->join('category_user', 'category_user.user_id', '=', 'users.id')->where('category_user.category_id', $categoryId);
        }

        if ($excludeUserIds !== []) {
            $query->whereNotIn('users.id', $excludeUserIds);
        }

        return $this->withStatus(array_values(array_map(intval(...), $query->orderBy('users.id')->pluck('users.id')->all())), $statuses);
    }

    /**
     * @param  list<PresenceStatus>  $statuses
     * @param  list<int>  $excludeUserIds
     */
    public function exists(?int $categoryId, array $statuses, array $excludeUserIds = []): bool
    {
        return $this->userIds($categoryId, $statuses, $excludeUserIds) !== [];
    }

    /**
     * Available agents per category, for the public availability endpoint. `$statuses` are the ones the widget's routing waves can
     * offer a chat to (`RoutingPlan::allStatuses()`), the same set `StartConversation` checks, so the two always agree; null means
     * `online` and `away`.
     *
     * @param  list<int>  $categoryIds
     * @param  list<PresenceStatus>|null  $statuses
     * @param  list<int>  $excludeUserIds  agents that do not count (the one handing a chat over)
     * @return array<int, int> category id => number of available agents (missing ids count as 0)
     */
    public function countByCategory(array $categoryIds, ?array $statuses = null, array $excludeUserIds = []): array
    {
        $statuses ??= [PresenceStatus::Online, PresenceStatus::Away];

        if ($categoryIds === [] || $statuses === []) {
            return [];
        }

        $query = $this->candidates()
            ->join('category_user', 'category_user.user_id', '=', 'users.id')
            ->whereIn('category_user.category_id', $categoryIds);

        if ($excludeUserIds !== []) {
            $query->whereNotIn('users.id', $excludeUserIds);
        }

        $rows = $query->select('category_user.category_id as category_id', 'users.id as user_id')->distinct()->get();
        $reachable = array_flip($this->withStatus(array_values(array_unique(array_map(static fn (object $row): int => (int) $row->user_id, $rows->all()))), $statuses));
        $counts = [];

        foreach ($rows as $row) {
            if (isset($reachable[(int) $row->user_id])) {
                $counts[(int) $row->category_id] = ($counts[(int) $row->category_id] ?? 0) + 1;
            }
        }

        return $counts;
    }

    /**
     * Which of these users can take a chat right now (active agent, status in `$statuses`, fresh heartbeat, below their capacity):
     * the one predicate a transfer to a colleague is checked with and `GET .../transfer-targets` reports as `reachable`.
     *
     * @param  list<int>  $userIds
     * @param  list<PresenceStatus>  $statuses
     * @return list<int>
     */
    public function availableAmong(array $userIds, array $statuses): array
    {
        if ($userIds === [] || $statuses === []) {
            return [];
        }

        return $this->withStatus(array_values(array_map(intval(...), $this->candidates()->whereIn('users.id', $userIds)->orderBy('users.id')->pluck('users.id')->all())), $statuses);
    }

    /**
     * Live chats being handled right now, per agent.
     *
     * @param  list<int>  $userIds
     * @return array<int, int> user id => active live chats (0 for agents without any)
     */
    public function activeChatCounts(array $userIds): array
    {
        $counts = array_fill_keys($userIds, 0);

        if ($userIds === []) {
            return $counts;
        }

        $rows = $this->activeChatsQuery()
            ->whereIn('conversations.assigned_agent_id', $userIds)
            ->groupBy('conversations.assigned_agent_id')
            ->selectRaw('conversations.assigned_agent_id as agent_id, count(*) as chats')
            ->get();

        foreach ($rows as $row) {
            $counts[(int) $row->agent_id] = (int) $row->chats;
        }

        return $counts;
    }

    /**
     * How many live chats the agent is handling right now.
     */
    public function activeChats(int $userId): int
    {
        return $this->activeChatsQuery()->where('conversations.assigned_agent_id', $userId)->count();
    }

    /**
     * Those of `$userIds` (order kept) whose effective status is one of `$statuses`.
     *
     * @param  list<int>  $userIds
     * @param  list<PresenceStatus>  $statuses
     * @return list<int>
     */
    private function withStatus(array $userIds, array $statuses): array
    {
        if ($userIds === []) {
            return [];
        }

        $effective = $this->presence->many($userIds);

        return array_values(array_filter($userIds, static fn (int $userId): bool => in_array($effective[$userId], $statuses, true)));
    }

    /**
     * Active agents with a free slot (presence is decided separately, from the store).
     *
     * @return Builder
     */
    private function candidates()
    {
        return DB::table('users')
            ->where('users.is_active', true)
            ->where('users.is_agent', true)
            ->whereRaw('(select count(*) from conversations where conversations.assigned_agent_id = users.id and conversations.status = ? and conversations.type = ?) < users.max_concurrent_chats', [
                ConversationStatus::Active->value,
                ConversationType::Live->value,
            ]);
    }

    /**
     * @return Builder
     */
    private function activeChatsQuery()
    {
        return DB::table('conversations')
            ->where('conversations.status', ConversationStatus::Active->value)
            ->where('conversations.type', ConversationType::Live->value);
    }
}
