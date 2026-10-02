<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Domain\WhatsApp\Actions\DeleteWaChat;
use App\Domain\WhatsApp\Actions\MarkChatRead;
use App\Domain\WhatsApp\Actions\SetChatArchived;
use App\Domain\WhatsApp\Queries\WaChatCursor;
use App\Domain\WhatsApp\Queries\WaChatListQuery;
use App\Http\Requests\WhatsApp\ListChatsRequest;
use App\Models\WaChat;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

/**
 * The admin inbox: `GET /whatsapp/chats` (filters, newest activity first, cursor), `GET /whatsapp/chats/{ulid}`, `POST .../read`,
 * `POST .../archive`, `POST .../unarchive`, `DELETE .../{ulid}` (erase for good, idempotent). Administrators only; every single chat is
 * authorised with `WhatsAppPolicy::view` (or `delete`).
 */
class WhatsAppChatController extends WhatsAppController
{
    public const RELATIONS = ['session', 'widget', 'category'];

    public function index(ListChatsRequest $request, WaChatListQuery $chats): JsonResponse
    {
        $limit = $request->limit();
        $rows = $chats->ordered($chats->build($request->filters()), $request->cursor())
            ->with(self::RELATIONS)
            ->limit($limit + 1)
            ->get();

        $page = $rows->take($limit)->values();
        $next = $rows->count() > $limit && $page->isNotEmpty() ? WaChatCursor::after($page->last())->encode() : null;

        return response()->json([
            'data' => $page->map(fn (WaChat $chat): array => WaChatData::fromModel($chat)->toArray())->all(),
            'meta' => ['next_cursor' => $next, 'unread_chats' => $chats->unreadChats()],
        ]);
    }

    public function show(Request $request, WaChat $chat): JsonResponse
    {
        Gate::forUser($this->admin($request))->authorize('view', $chat);

        return $this->data(WaChatDetailData::fromModel($chat->load([...self::RELATIONS, 'visitor', 'handoffTicket'])));
    }

    public function read(Request $request, WaChat $chat, MarkChatRead $action): JsonResponse
    {
        return $this->data(WaChatData::fromModel($action->handle($chat, $this->admin($request))->load(self::RELATIONS)));
    }

    public function archive(Request $request, WaChat $chat, SetChatArchived $action): JsonResponse
    {
        return $this->data(WaChatData::fromModel($action->handle($chat, true, $this->admin($request))->load(self::RELATIONS)));
    }

    public function unarchive(Request $request, WaChat $chat, SetChatArchived $action): JsonResponse
    {
        return $this->data(WaChatData::fromModel($action->handle($chat, false, $this->admin($request))->load(self::RELATIONS)));
    }

    /** Erases the chat, its messages and stored images; `204` whether or not it was still there (the second call of a repeated delete is no error). */
    public function destroy(Request $request, string $chat, DeleteWaChat $action): Response
    {
        $action->handle($chat, $this->admin($request));

        return response()->noContent();
    }
}
