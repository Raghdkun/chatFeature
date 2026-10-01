<?php

namespace App\Domain\Chat\Support;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Widgets\Support\AppOrigin;
use App\Models\Attachment;
use Illuminate\Routing\UrlGenerator;

/**
 * Temporary signed URLs for the named route `public.attachments.show`, which the Chat REST track registers as
 * `GET /api/v1/public/attachments/{attachment}` (`{attachment}` = the attachment ulid) behind the `signed` middleware.
 * The thumbnail uses the same route with `?thumb=1` (part of the signed query). Generating a URL needs the route to exist;
 * the signature itself is the credential, so no bearer token is needed to fetch it.
 *
 * The URLs live `chat.attachment_url_ttl_minutes` (setting, default 240: chats last hours) and are built on the configured app
 * origin (`AppOrigin`, as snippets and boot configs are), never on the host of the current request: a forged `Host` header must not
 * decide where a visitor's browser is sent. The origin is forced on a CLONE of the URL generator, so nothing else the request
 * generates is affected.
 */
final class SignedAttachmentUrls implements AttachmentUrls
{
    public const ROUTE = 'public.attachments.show';

    public const DEFAULT_TTL_MINUTES = 240;

    public function __construct(
        private readonly UrlGenerator $urls,
        private readonly AppOrigin $origin,
    ) {}

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
        $minutes = max(1, settings()->int('chat.attachment_url_ttl_minutes', self::DEFAULT_TTL_MINUTES));

        return $this->generator()->temporarySignedRoute(self::ROUTE, now()->addMinutes($minutes), ['attachment' => $attachment->ulid] + $query);
    }

    private function generator(): UrlGenerator
    {
        $origin = $this->origin->url();
        $generator = clone $this->urls;
        $generator->forceRootUrl($origin);
        $generator->forceScheme((string) parse_url($origin, PHP_URL_SCHEME));

        return $generator;
    }
}
