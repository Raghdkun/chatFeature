<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WaMessageData;
use App\Domain\WhatsApp\Actions\SendReply;
use App\Domain\WhatsApp\Queries\WaMessagePage;
use App\Http\Requests\WhatsApp\ListMessagesRequest;
use App\Http\Requests\WhatsApp\SendReplyRequest;
use App\Models\WaChat;
use App\Models\WaMessage;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;

/**
 * `GET /whatsapp/chats/{ulid}/messages` (a transcript page, oldest first) and `POST` (an administrator's reply: stored `pending`, sent by a
 * queued job; a repeated `client_msg_id` answers `200` with the original).
 */
class WhatsAppMessageController extends WhatsAppController
{
    public function index(ListMessagesRequest $request, WaChat $chat, WaMessagePage $pages): JsonResponse
    {
        Gate::forUser($this->admin($request))->authorize('view', $chat);

        $page = $pages->fetch($chat->loadMissing('session', 'widget', 'category'), $request->validated('after_id'), $request->validated('before_id'), $request->limit());

        return response()->json([
            'data' => array_map(fn (WaMessage $message): array => WaMessageData::fromModel($message)->toArray(), $page['messages']),
            'meta' => ['next_cursor' => $page['next_cursor'], 'prev_cursor' => $page['prev_cursor']],
        ]);
    }

    public function store(SendReplyRequest $request, WaChat $chat, SendReply $action): JsonResponse
    {
        $sent = $action->handle($chat, $this->admin($request), (string) $request->validated('body'), $request->clientMsgId());
        $message = $sent['message']->load(['chat.session', 'sentBy']);

        return $this->data(WaMessageData::fromModel($message), $sent['created'] ? 201 : 200);
    }
}
