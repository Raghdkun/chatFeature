<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\AttachmentData;
use App\Domain\Chat\Actions\UploadAttachment;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Services\ConversationAccess;
use App\Http\Requests\Chat\UploadAttachmentRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\UploadedFile;

/** `POST /conversations/{ulid}/attachments`: an agent uploads an image into their active chat. */
class ChatStaffAttachmentController extends ChatStaffController
{
    public function store(UploadAttachmentRequest $request, Conversation $conversation, ConversationAccess $access, UploadAttachment $action): JsonResponse
    {
        $user = $this->staff($request);
        $access->participant($user, $conversation);

        /** @var UploadedFile $file */
        $file = $request->file('file');

        return $this->data(AttachmentData::fromModel($action->handle($conversation, $file, SenderType::Agent, $user)), 201);
    }
}
