<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\MessageData;
use App\Domain\Chat\Actions\SendMessage;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Services\ConversationMessages;
use App\Http\Requests\Chat\ListMessagesRequest;
use App\Http\Requests\Chat\SendMessageRequest;
use Illuminate\Http\JsonResponse;

/** `GET/POST /public/conversations/{ulid}/messages`: always the visitor-safe `MessageData` (no staff ids). */
class ChatMessageController extends ChatVisitorController
{
    public function index(ListMessagesRequest $request, string $ulid, ConversationMessages $messages): JsonResponse
    {
        $page = $messages->after($this->conversation($request, $ulid), $request->afterSeq(), $request->limit());

        return response()->json([
            'data' => array_map(fn ($message): array => MessageData::fromModel($message)->toArray(), $page['messages']),
            'meta' => ['next_cursor' => $page['next_cursor']],
        ]);
    }

    public function store(SendMessageRequest $request, string $ulid, SendMessage $action): JsonResponse
    {
        $sent = $action->handle(
            $this->conversation($request, $ulid),
            SenderType::Visitor,
            null,
            $request->validated('body'),
            $request->attachmentUlids(),
            $request->clientMsgId(),
        );

        return $this->data(MessageData::fromModel($sent->message), $sent->created ? 201 : 200);
    }
}
