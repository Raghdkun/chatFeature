<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Domain\Chat\Actions\RecordReceipts;
use App\Domain\Chat\Enums\SenderType;
use App\Http\Requests\Chat\ReceiptsRequest;
use Illuminate\Http\Response;

/** `POST .../receipts`: the visitor's widget reports what it received and showed (batched by the client). */
class ChatReceiptController extends ChatVisitorController
{
    public function store(ReceiptsRequest $request, string $ulid, RecordReceipts $action): Response
    {
        $action->handle($this->conversation($request, $ulid), SenderType::Visitor, $request->deliveredUpto(), $request->seenUpto());

        return response()->noContent();
    }
}
