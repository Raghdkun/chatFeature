<?php

namespace App\Domain\Chat\Realtime\Support;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Models\Conversation;
use Illuminate\Support\Facades\DB;

/**
 * The staff users (other than the admins on `private-admin`) a change of one conversation is sent to: exactly the people
 * `ConversationPolicy::viewAsStaff()` lets see it, namely the assigned agent, agents holding an open offer while the chat is
 * `queued`, and agents serving the category of a queued offline ticket (every active agent when the ticket has no category). `$extra` adds people who just lost sight of it (the
 * agent a chat was transferred away from) so their list drops the row. Parity with the policy is pinned by a test.
 */
final class ConversationAudience
{
    /**
     * @param  list<int>  $extra
     * @return list<int>
     */
    public function staffIds(Conversation $conversation, array $extra = []): array
    {
        $ids = $extra;

        if ($conversation->assigned_agent_id !== null) {
            $ids[] = $conversation->assigned_agent_id;
        }

        if ($conversation->status === ConversationStatus::Queued) {
            array_push($ids, ...$conversation->offers()->open()->pluck('user_id')->map(fn ($id): int => (int) $id)->all());

            if ($conversation->type === ConversationType::Offline) {
                $servers = $conversation->category_id === null
                    ? DB::table('users')->where('is_active', true)->where('is_agent', true)->pluck('id')
                    : DB::table('category_user')->where('category_id', $conversation->category_id)->pluck('user_id');

                array_push($ids, ...$servers->map(fn ($id): int => (int) $id)->all());
            }
        }

        return ActiveStaff::only($ids);
    }
}
