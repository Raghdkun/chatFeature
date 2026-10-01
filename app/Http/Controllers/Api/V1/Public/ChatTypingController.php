<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Realtime\Broadcasts\TypingBroadcast;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Chat\TypingRequest;
use Illuminate\Http\Response;

/**
 * `POST .../typing`: the REST fallback of the typing whisper (clients whisper over the websocket; this is for when they cannot).
 * After the usual checks it publishes the realtime `typing` event (`TypingBroadcast`); typing is not a message: nothing is stored
 * and it never counts as activity for the idle timer.
 */
class ChatTypingController extends ChatVisitorController
{
    public function store(TypingRequest $request, string $ulid): Response
    {
        $conversation = $this->conversation($request, $ulid);

        if ($conversation->status !== ConversationStatus::Active) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        TypingBroadcast::dispatch($conversation->ulid, SenderType::Visitor, $request->boolean('typing'));

        return response()->noContent();
    }
}
