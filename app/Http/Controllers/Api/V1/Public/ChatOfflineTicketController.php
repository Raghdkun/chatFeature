<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\ConversationPublicData;
use App\Domain\Chat\Actions\CreateOfflineTicket;
use App\Http\Requests\Chat\CreateOfflineTicketRequest;
use Illuminate\Http\JsonResponse;

/** `POST /public/offline-tickets`: the offline form (decision P4-D2). */
class ChatOfflineTicketController extends ChatVisitorController
{
    public function store(CreateOfflineTicketRequest $request, CreateOfflineTicket $action): JsonResponse
    {
        /** @var array{name: string, email: string, message: string, category?: string|null, missed_conversation?: string|null} $input */
        $input = $request->validated();

        return $this->data(ConversationPublicData::fromModel($action->handle($this->session($request), $input)), 201);
    }
}
