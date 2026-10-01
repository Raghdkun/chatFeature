<?php

namespace App\Domain\Chat\Contracts;

use App\Models\Attachment;

/**
 * Turns a stored attachment into the short-lived URLs clients load images from (`AttachmentData.url` / `thumbUrl`).
 * The default implementation signs `GET /api/v1/public/attachments/{ulid}` (route `public.attachments.show`, registered by
 * the Chat REST track); tests bind a fake so Data classes can be built without that route.
 */
interface AttachmentUrls
{
    /** Signed URL of the full-size image. */
    public function url(Attachment $attachment): string;

    /** Signed URL of the thumbnail, or null when the attachment has none. */
    public function thumbUrl(Attachment $attachment): ?string;
}
