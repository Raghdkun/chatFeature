<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;

/**
 * `GET /api/sessions/{id}/qr` (`{qrCode, status}`) and the `data.qr` of a `session.qr` webhook: a PNG data URL the page renders in an
 * `<img>`. Anything that is not a base64 PNG data URL of a sane size is refused, because the value is stored and put into an `src`.
 */
final readonly class OpenWaQr
{
    /** A QR code is a few KiB; this refuses a payload that is clearly something else. */
    public const MAX_LENGTH = 200_000;

    public function __construct(
        public string $dataUrl,
        public ?SessionStatus $status = null,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload  `{qrCode, status}` of the REST answer, or `{qr}` of the webhook
     *
     * @throws OpenWaUnavailable when there is no usable QR in it
     */
    public static function fromArray(array $payload): self
    {
        $qr = $payload['qrCode'] ?? $payload['qr'] ?? null;

        if (! self::isPngDataUrl($qr)) {
            throw new OpenWaUnavailable('OpenWA returned a QR code that is not a PNG data URL.');
        }

        return new self($qr, SessionStatus::fromOpenWa(is_string($payload['status'] ?? null) ? $payload['status'] : null));
    }

    /** @phpstan-assert-if-true non-empty-string $value */
    public static function isPngDataUrl(mixed $value): bool
    {
        return is_string($value)
            && strlen($value) <= self::MAX_LENGTH
            && preg_match('#^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$#', $value) === 1;
    }
}
