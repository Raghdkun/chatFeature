<?php

namespace Tests\Support;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Models\Attachment;

/**
 * Attachment URLs without the signed route: deterministic strings that name the attachment (and carry a fake signature, so a
 * test can tell them from storage paths). Bind with `$this->app->instance(AttachmentUrls::class, new FakeAttachmentUrls)`.
 */
final class FakeAttachmentUrls implements AttachmentUrls
{
    public function url(Attachment $attachment): string
    {
        return 'https://files.test/attachments/'.$attachment->ulid.'?signature=fake';
    }

    public function thumbUrl(Attachment $attachment): ?string
    {
        return $attachment->thumb_path === null ? null : 'https://files.test/attachments/'.$attachment->ulid.'?thumb=1&signature=fake';
    }
}
