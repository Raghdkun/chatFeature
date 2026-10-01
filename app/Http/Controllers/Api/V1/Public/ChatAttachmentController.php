<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\AttachmentData;
use App\Domain\Chat\Actions\UploadAttachment;
use App\Domain\Chat\Enums\SenderType;
use App\Http\Requests\Chat\UploadAttachmentRequest;
use App\Models\Attachment;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * `POST .../attachments` (the visitor uploads an image) and `GET /public/attachments/{attachment}` (route
 * `public.attachments.show`, the target of the signed URLs in `MessageData`).
 *
 * The signature is the credential for the GET: it is valid for 30 minutes and names exactly one attachment (and `thumb=1`).
 * The file is streamed from the private disk with the stored (sniffed) content type, `nosniff` and a locked-down CSP, under a neutral
 * file name; the original name never leaves staff payloads.
 */
class ChatAttachmentController extends ChatVisitorController
{
    public function store(UploadAttachmentRequest $request, string $ulid, UploadAttachment $action): JsonResponse
    {
        /** @var UploadedFile $file */
        $file = $request->file('file');

        $attachment = $action->handle($this->conversation($request, $ulid), $file, SenderType::Visitor);

        return $this->data(AttachmentData::fromModel($attachment), 201);
    }

    public function show(Request $request, Attachment $attachment): Response
    {
        $path = $request->boolean('thumb') ? $attachment->thumb_path : $attachment->path;
        $disk = Storage::disk($attachment->disk);

        if ($path === null || $path === '' || ! $disk->exists($path)) {
            throw new NotFoundHttpException;
        }

        return $disk->response($path, 'image.'.pathinfo($path, PATHINFO_EXTENSION), [
            'Content-Type' => $attachment->mime,
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "default-src 'none'; sandbox",
            'Cache-Control' => 'private, max-age=600',
        ]);
    }
}
