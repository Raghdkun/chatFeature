<?php

namespace App\Http\Controllers\Dashboard\Concerns;

use App\Data\Chat\ConversationStaffData;
use App\Models\Conversation;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * What the staff dashboard pages share: the relations `ConversationStaffData` reads (eager-loaded once per list, never per row)
 * and the conversion of a list into the `ConversationStaff[]` props of docs/contracts/chat-ui-p4.md.
 */
trait PresentsConversations
{
    /**
     * @var list<string>
     */
    private const CONVERSATION_RELATIONS = ['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget'];

    /**
     * @param  Builder<Conversation>  $query
     * @return Builder<Conversation>
     */
    private function withStaffRelations(Builder $query): Builder
    {
        return $query->with(self::CONVERSATION_RELATIONS);
    }

    /**
     * @param  Collection<int, Conversation>  $conversations
     * @return array<int, array<string, mixed>>
     */
    private function staffRows(Collection $conversations): array
    {
        return $conversations
            ->map(fn (Conversation $conversation): array => ConversationStaffData::fromModel($conversation)->toArray())
            ->values()
            ->all();
    }
}
