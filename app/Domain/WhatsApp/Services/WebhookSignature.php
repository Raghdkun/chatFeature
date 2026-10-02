<?php

namespace App\Domain\WhatsApp\Services;

use SensitiveParameter;

/**
 * `X-OpenWA-Signature: sha256=<hex>`: HMAC-SHA256 of the RAW request body (the exact bytes, never re-encoded JSON) with the webhook
 * secret OpenWA was given at registration (`docs/reference/openwa-api.md` section 6.6).
 *
 * The check always does the same work: the HMAC is computed and compared in constant time even when the header is missing or
 * malformed or when the session has no secret (then against a fixed dummy key and always refused), so the time an answer takes says
 * nothing about which of those it was. The hex is lower case, as OpenWA writes it; anything else is malformed.
 */
final class WebhookSignature
{
    public const HEADER = 'X-OpenWA-Signature';

    private const PREFIX = 'sha256=';

    /** A well-formed header value that never matches: what a missing or malformed header is compared as. */
    private const NEVER = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    private const DUMMY_KEY = 'no-webhook-secret-registered';

    public function valid(string $rawBody, ?string $header, #[SensitiveParameter] ?string $secret): bool
    {
        $hasSecret = is_string($secret) && $secret !== '';
        $wellFormed = is_string($header) && preg_match('/^sha256=[0-9a-f]{64}$/D', $header) === 1;

        $expected = self::sign($rawBody, $hasSecret ? $secret : self::DUMMY_KEY);
        $equal = hash_equals($expected, $wellFormed ? $header : self::NEVER);

        return $equal && $wellFormed && $hasSecret;
    }

    /** The header value for a body: what OpenWA sends (and what tests send). */
    public static function sign(string $rawBody, #[SensitiveParameter] string $secret): string
    {
        return self::PREFIX.hash_hmac('sha256', $rawBody, $secret);
    }
}
