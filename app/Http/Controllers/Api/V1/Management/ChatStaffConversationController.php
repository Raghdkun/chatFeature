<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\ConversationStaffData;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Queries\ConversationListQuery;
use App\Domain\Chat\Services\ConversationAccess;
use App\Http\Requests\Chat\ListConversationsRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `GET /conversations` (filters + cursor paging), `GET /conversations/queue` and `GET /conversations/{ulid}`. Every query starts from
 * `Conversation::visibleTo($user)`; a single conversation the caller may not see is `403`.
 */
class ChatStaffConversationController extends ChatStaffController
{
    /** The queue is short by nature; this bounds the response anyway. */
    private const QUEUE_LIMIT = 200;

    private const RELATIONS = ['category', 'assignedAgent', 'visitor', 'widget'];

    public function index(ListConversationsRequest $request, ConversationListQuery $conversations): JsonResponse
    {
        $page = $conversations->build($this->staff($request), $request->filters())
            ->with(self::RELATIONS)
            ->orderByDesc('conversations.id')
            ->cursorPaginate($request->limit());

        return response()->json([
            'data' => $page->getCollection()->map(fn (Conversation $conversation): array => ConversationStaffData::fromModel($conversation)->toArray())->values()->all(),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode()],
        ]);
    }

    public function queue(Request $request): JsonResponse
    {
        $queued = Conversation::query()
            ->visibleTo($this->staff($request))
            ->where('conversations.status', ConversationStatus::Queued->value)
            ->with(self::RELATIONS)
            ->orderBy('conversations.queued_at')
            ->orderBy('conversations.id')
            ->limit(self::QUEUE_LIMIT)
            ->get();

        return $this->list($queued->map(fn (Conversation $conversation): array => ConversationStaffData::fromModel($conversation)->toArray()));
    }

    public function show(Request $request, Conversation $conversation, ConversationAccess $access): JsonResponse
    {
        $access->view($this->staff($request), $conversation);

        return $this->data(ConversationStaffData::fromModel($conversation->load(self::RELATIONS)));
    }
}
