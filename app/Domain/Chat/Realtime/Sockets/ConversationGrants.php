<?php

namespace App\Domain\Chat\Realtime\Sockets;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Models\Conversation;
use App\Models\RealtimeGrant;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Which staff members were handed a signed subscription to a conversation channel, and the judgement of those grants when the access to
 * the conversation changes (transfer, claim by somebody else, assignment, a chat handed back to the queue): a member who no longer
 * passes `ConversationPolicy::viewAsStaff()` gets their sockets closed (they reconnect and are refused that channel).
 *
 * An administrator's access follows the role, which has its own hook (a user whose `is_admin` goes off loses every socket), so only
 * agents are recorded. A row means "may be subscribed": it is refreshed on every grant, dropped when the access is judged lost, and
 * pruned after `chat.realtime.grant_ttl_days` (a socket that old has reconnected and been granted again long ago).
 */
final class ConversationGrants
{
    public function __construct(
        private readonly ConversationPolicy $policy,
        private readonly SocketCutOff $cutoff,
    ) {}

    public function record(User $user, Conversation $conversation): void
    {
        if ($user->is_admin) {
            return;
        }

        RealtimeGrant::query()->upsert(
            [['user_id' => $user->id, 'conversation_id' => $conversation->id, 'granted_at' => now()]],
            ['user_id', 'conversation_id'],
            ['granted_at'],
        );
    }

    /**
     * Judges every grant of the conversation against its CURRENT state.
     *
     * @return list<int> the staff ids whose sockets were closed
     */
    public function revalidate(Conversation $conversation): array
    {
        $current = Conversation::query()->find($conversation->id);

        if ($current === null) {
            return [];
        }

        $cut = [];

        foreach (RealtimeGrant::query()->where('conversation_id', $current->id)->with('user')->get() as $grant) {
            if ($this->policy->viewAsStaff($grant->user, $current)) {
                continue;
            }

            $this->cutoff->cutStaff($grant->user_id, 'conversation_access_lost');
            $grant->delete();
            $cut[] = $grant->user_id;
        }

        return $cut;
    }

    /**
     * Conversations touched recently that somebody holds a grant on: the sweep's backstop for a lost event.
     *
     * @return list<int>
     */
    public function recentlyChangedConversationIds(int $minutes = 10, int $limit = 500): array
    {
        $ids = DB::table('realtime_grants')
            ->join('conversations', 'conversations.id', '=', 'realtime_grants.conversation_id')
            ->where('conversations.updated_at', '>=', now()->subMinutes($minutes))
            ->distinct()
            ->limit($limit)
            ->pluck('realtime_grants.conversation_id');

        return array_values($ids->map(fn ($id): int => (int) $id)->all());
    }

    public function prune(): int
    {
        return RealtimeGrant::query()
            ->where('granted_at', '<', now()->subDays(max(1, (int) config('chat.realtime.grant_ttl_days', 14))))
            ->delete();
    }
}
