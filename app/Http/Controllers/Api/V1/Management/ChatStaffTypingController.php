<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Domain\Chat\Services\ConversationAccess;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Chat\TypingRequest;
use App\Models\Conversation;
use Illuminate\Http\Response;

/** `POST /conversations/{ulid}/typing`: REST fallback of the typing whisper (validated, authorised, then published as the realtime `typing` event). */
class ChatStaffTypingController extends ChatStaffController
{
    public function store(TypingRequest $request, Conversation $conversation, ConversationAccess $access): Response
    {
        $access->assignedAgent($this->staff($request), $conversation);

        if ($conversation->status !== ConversationStatus::Active) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        TypingBroadcast::dispatch($conversation->ulid, SenderType::Agent, $request->boolean('typing'));

        return response()->noContent();
    }
}
