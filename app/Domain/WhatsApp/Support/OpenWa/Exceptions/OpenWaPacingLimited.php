<?php

namespace App\Domain\WhatsApp\Support\OpenWa\Exceptions;

/**
 * `429 SEND_PACING_LIMITED`: OpenWA's send pacing (warm-up cap, cold-reachout cap or failure breaker) refused a send. Unlike the global
 * rate limiter's 429 it can last hours: do not retry before `retryAfterSeconds`.
 */
final class OpenWaPacingLimited extends OpenWaRejected
{
    public function __construct(
        public readonly int $retryAfterSeconds,
        string $message = '',
    ) {
        parent::__construct('SEND_PACING_LIMITED', 429, $message);
    }
}
