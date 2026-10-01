<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\ConversationPublicData;
use App\Domain\Chat\Actions\CancelQueuedConversation;
use App\Domain\Chat\Actions\EndConversation;
use App\Domain\Chat\Actions\StartConversation;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Chat\StartConversationRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The visitor's chat: `GET /public/conversation` (this session's latest live conversation: visitors never list history),
 * `POST /public/conversations` (start), `POST .../end`, `POST .../cancel` (while still queued).
 */
class ChatConversationController extends ChatVisitorController
{
    public function show(Request $request): JsonResponse
    {
        $conversation = Conversation::query()
            ->with(['category', 'assignedAgent'])
            ->where('visitor_session_id', $this->session($request)->id)
            ->where('type', ConversationType::Live->value)
            ->orderByDesc('id')
            ->first();

        return $this->data($conversation === null ? null : ConversationPublicData::fromModel($conversation));
    }

    public function store(StartConversationRequest $request, StartConversation $action): JsonResponse
    {
        /** @var array{category: string, name?: string|null, email?: string|null, phone?: string|null, message?: string|null} $input */
        $input = $request->validated();

        return $this->data(ConversationPublicData::fromModel($action->handle($this->session($request), $input)), 201);
    }

    public function end(Request $request, string $ulid, EndConversation $action, WidgetConfigValidator $configs): JsonResponse
    {
        $conversation = $this->conversation($request, $ulid);

        if (! $configs->hydrate($this->widget($request)->config)->features->endChatByVisitor) {
            throw ApiProblemException::forbidden('feature_disabled', __('This chat cannot be ended by the visitor.'));
        }

        return $this->data(ConversationPublicData::fromModel($action->handle($conversation, ConversationEndedBy::Visitor, $conversation->visitor_id)));
    }

    public function cancel(Request $request, string $ulid, CancelQueuedConversation $action): JsonResponse
    {
        return $this->data(ConversationPublicData::fromModel($action->handle($this->conversation($request, $ulid))));
    }
}
