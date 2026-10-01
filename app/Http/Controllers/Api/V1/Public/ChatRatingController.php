<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\ConversationPublicData;
use App\Data\Chat\RatingData;
use App\Domain\Chat\Actions\RateConversation;
use App\Domain\Chat\Actions\SkipRating;
use App\Http\Requests\Chat\RatingRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** `POST .../rating` (score 1..5, optional comment) and `POST .../rating/skip`: the visitor's answer to the rating prompt. */
class ChatRatingController extends ChatVisitorController
{
    public function store(RatingRequest $request, string $ulid, RateConversation $action): JsonResponse
    {
        $rating = $action->handle(
            $this->conversation($request, $ulid),
            (int) $request->validated('score'),
            $request->validated('comment'),
        );

        return $this->data(RatingData::fromModel($rating), 201);
    }

    public function skip(Request $request, string $ulid, SkipRating $action): JsonResponse
    {
        return $this->data(ConversationPublicData::fromModel($action->handle($this->conversation($request, $ulid))));
    }
}
