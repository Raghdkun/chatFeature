<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\MessageData;
use App\Domain\Chat\Actions\SendMessage;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Services\ConversationAccess;
use App\Domain\Chat\Services\ConversationMessages;
use App\Http\Requests\Chat\ListMessagesRequest;
use App\Http\Requests\Chat\SendMessageRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;

/** `GET/POST /conversations/{ulid}/messages`: staff see the sender's user id (`forStaff`); a reply on an offline ticket is e-mailed. */
class ChatStaffMessageController extends ChatStaffController
{
    public function index(ListMessagesRequest $request, Conversation $conversation, ConversationAccess $access, ConversationMessages $messages): JsonResponse
    {
        $access->view($this->staff($request), $conversation);

        $page = $messages->after($conversation, $request->afterSeq(), $request->limit());

        return response()->json([
            'data' => array_map(fn ($message): array => MessageData::fromModel($message, forStaff: true)->toArray(), $page['messages']),
            'meta' => ['next_cursor' => $page['next_cursor']],
        ]);
    }

    public function store(SendMessageRequest $request, Conversation $conversation, ConversationAccess $access, SendMessage $action): JsonResponse
    {
        $user = $this->staff($request);
        $access->participant($user, $conversation);

        $sent = $action->handle($conversation, SenderType::Agent, $user, $request->validated('body'), $request->attachmentUlids(), $request->clientMsgId());

        return $this->data(MessageData::fromModel($sent->message, forStaff: true), $sent->created ? 201 : 200);
    }
}
