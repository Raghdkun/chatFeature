<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

use RuntimeException;

/**
 * OpenWA understood the request and refused it (a 4xx). `errorCode` is the machine-readable `code` of the body when there is one
 * (`SESSION_NAME_TEARDOWN_PENDING`, `SEND_PACING_LIMITED`, ...), else a slug of the status (`not_found`, `unauthorized`, ...);
 * `status` the HTTP status. OpenWA's own message (a string, or the list of validation messages joined) is the exception message: it is
 * shown to administrators only, never to visitors.
 */
class OpenWaRejected extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        public readonly int $status,
        string $message = '',
    ) {
        parent::__construct($message !== '' ? $message : 'OpenWA refused the request ('.$errorCode.').');
    }

    /**
     * From the NestJS error body OpenWA answers with (`{statusCode, message: string|string[], error, code?, retryAfterSeconds?}`);
     * a `429` with `code: SEND_PACING_LIMITED` becomes an {@see OpenWaPacingLimited}. Tolerant: a body that is not that shape still gives
     * a usable exception.
     *
     * @param  array<array-key, mixed>  $body
     */
    public static function fromResponse(int $status, array $body, ?int $retryAfterHeader = null): self
    {
        $code = is_string($body['code'] ?? null) && $body['code'] !== '' ? $body['code'] : self::codeForStatus($status);
        $message = $body['message'] ?? '';
        $message = is_array($message) ? implode('; ', array_filter($message, 'is_string')) : (is_scalar($message) ? (string) $message : '');
        $message = mb_substr($message, 0, 500);

        if ($status === 429 && $code === 'SEND_PACING_LIMITED') {
            $retryAfter = $body['retryAfterSeconds'] ?? $retryAfterHeader;

            return new OpenWaPacingLimited(is_numeric($retryAfter) ? (int) $retryAfter : 60, $message);
        }

        return new self($code, $status, $message);
    }

    public function isNotFound(): bool
    {
        return $this->status === 404;
    }

    public function isConflict(): bool
    {
        return $this->status === 409;
    }

    /** The API key is missing, wrong, revoked or too weak for the call. */
    public function isUnauthorized(): bool
    {
        return $this->status === 401 || $this->status === 403;
    }

    private static function codeForStatus(int $status): string
    {
        return match ($status) {
            400 => 'bad_request',
            401 => 'unauthorized',
            403 => 'forbidden',
            404 => 'not_found',
            409 => 'conflict',
            413 => 'payload_too_large',
            429 => 'rate_limited',
            default => 'rejected',
        };
    }
}
