<?php

namespace App\Domain\Chat\Support;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Models\Attachment;
use Illuminate\Contracts\Routing\UrlGenerator;

/**
 * Temporary signed URLs for the named route `public.attachments.show`, which the Chat REST track registers as
 * `GET /api/v1/public/attachments/{attachment}` (`{attachment}` = the attachment ulid) behind the `signed` middleware.
 * The thumbnail uses the same route with `?thumb=1` (part of the signed query). Generating a URL needs the route to exist;
 * the signature itself is the credential, so no bearer token is needed to fetch it.
 */
final class SignedAttachmentUrls implements AttachmentUrls
{
    public const ROUTE = 'public.attachments.show';

    public const TTL_MINUTES = 30;

    public function __construct(private readonly UrlGenerator $urls) {}

    public function url(Attachment $attachment): string
    {
        return $this->sign($attachment, []);
    }

    public function thumbUrl(Attachment $attachment): ?string
    {
        return $attachment->thumb_path === null || $attachment->thumb_path === '' ? null : $this->sign($attachment, ['thumb' => 1]);
    }

    /**
     * @param  array<string, scalar>  $query
     */
    private function sign(Attachment $attachment, array $query): string
    {
        return $this->urls->temporarySignedRoute(self::ROUTE, now()->addMinutes(self::TTL_MINUTES), ['attachment' => $attachment->ulid] + $query);
    }
}
