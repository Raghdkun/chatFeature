<?php

namespace App\Domain\WhatsApp\Support;

use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\Widgets\Support\AppOrigin;
use App\Models\WaMessage;
use Illuminate\Routing\UrlGenerator;

/**
 * Temporary signed URLs for the named route `whatsapp.media.show`, which the WhatsApp REST track registers as
 * `GET /api/v1/whatsapp/media/{message}` (`{message}` = the message ulid) behind the `signed` middleware. The signature is the
 * credential (an `<img>` cannot send a bearer token), so a URL is only ever put into admin-only payloads and expires after
 * {@see self::TTL_MINUTES} minutes. Generating a URL needs the route to exist.
 *
 * Like `SignedAttachmentUrls` the URL is built on the configured app origin, never on the host of the current request.
 */
final class SignedWaMediaUrls implements WaMediaUrls
{
    public const ROUTE = 'whatsapp.media.show';

    public const TTL_MINUTES = 60;

    public function __construct(
        private readonly UrlGenerator $urls,
        private readonly AppOrigin $origin,
    ) {}

    public function url(WaMessage $message): string
    {
        $origin = $this->origin->url();
        $generator = clone $this->urls;
        $generator->forceRootUrl($origin);
        $generator->forceScheme((string) parse_url($origin, PHP_URL_SCHEME));

        return $generator->temporarySignedRoute(self::ROUTE, now()->addMinutes(self::TTL_MINUTES), ['message' => $message->ulid]);
    }
}
