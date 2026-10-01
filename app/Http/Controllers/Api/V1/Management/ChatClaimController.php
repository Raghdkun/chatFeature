<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\ConversationStaffData;
use App\Domain\Chat\Actions\ClaimConversation;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** `POST /conversations/{ulid}/claim`: the atomic accept (`409 already_claimed` when someone else was first). */
class ChatClaimController extends ChatStaffController
{
    public function store(Request $request, Conversation $conversation, ClaimConversation $action): JsonResponse
    {
        return $this->data(ConversationStaffData::fromModel($action->handle($conversation, $this->staff($request))));
    }
}
