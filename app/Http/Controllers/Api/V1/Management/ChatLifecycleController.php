<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\ConversationStaffData;
use App\Domain\Chat\Actions\CloseConversation;
use App\Domain\Chat\Actions\EndConversation;
use App\Domain\Chat\Actions\TransferConversation;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Services\ConversationAccess;
use App\Http\Requests\Chat\TransferConversationRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** `POST /conversations/{ulid}/end`, `.../close` and `.../transfer`: what an agent or admin does to the chat itself. */
class ChatLifecycleController extends ChatStaffController
{
    public function end(Request $request, Conversation $conversation, ConversationAccess $access, EndConversation $action): JsonResponse
    {
        $user = $this->staff($request);
        $access->participant($user, $conversation);

        $by = $conversation->assigned_agent_id === $user->id ? ConversationEndedBy::Agent : ConversationEndedBy::Admin;

        return $this->data(ConversationStaffData::fromModel($action->handle($conversation, $by, $user->id)));
    }

    public function close(Request $request, Conversation $conversation, CloseConversation $action): JsonResponse
    {
        return $this->data(ConversationStaffData::fromModel($action->handle($conversation, $this->staff($request))));
    }

    public function transfer(TransferConversationRequest $request, Conversation $conversation, TransferConversation $action): JsonResponse
    {
        $moved = $action->handle($conversation, $this->staff($request), $request->agent(), $request->category());

        return $this->data(ConversationStaffData::fromModel($moved->load(['category', 'assignedAgent', 'visitor', 'widget'])));
    }
}
