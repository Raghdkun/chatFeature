<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Chat\Actions\RecordReceipts;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Services\ConversationAccess;
use App\Http\Requests\Chat\ReceiptsRequest;
use App\Models\Conversation;
use Illuminate\Http\Response;

/** `POST /conversations/{ulid}/receipts`: only the agent the chat is assigned to reads it (an admin looking in does not). */
class ChatStaffReceiptController extends ChatStaffController
{
    public function store(ReceiptsRequest $request, Conversation $conversation, ConversationAccess $access, RecordReceipts $action): Response
    {
        $access->assignedAgent($this->staff($request), $conversation);

        $action->handle($conversation, SenderType::Agent, $request->deliveredUpto(), $request->seenUpto());

        return response()->noContent();
    }
}
