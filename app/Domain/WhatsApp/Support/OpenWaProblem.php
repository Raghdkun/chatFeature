<?php

namespace App\Domain\WhatsApp\Support;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaAddressRefused;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaNotConfigured;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Http\Exceptions\ApiProblemException;
use Throwable;

/**
 * What an administrator is told when the call to OpenWA behind their click failed. OpenWA's statuses are NEVER mirrored: a `401` from
 * OpenWA (it refused our API key) must not look like the dashboard's own `401` (that would end the administrator's session), so
 * every upstream failure is a `502` / `503` / `409` with its own code (docs/rest-api.md, "Error codes (WhatsApp)").
 */
final class OpenWaProblem
{
    public const TEARDOWN_PENDING = 'SESSION_NAME_TEARDOWN_PENDING';

    public static function from(Throwable $exception): ApiProblemException
    {
        return match (true) {
            $exception instanceof OpenWaNotConfigured => new ApiProblemException(409, 'openwa_not_configured', __('Save the OpenWA address and API key in Settings > WhatsApp first.')),
            $exception instanceof OpenWaAddressRefused => new ApiProblemException(503, 'openwa_unavailable', __('The saved OpenWA address is not allowed. Check Settings > WhatsApp (an address on a private network needs the "allow private hosts" server setting).')),
            $exception instanceof OpenWaRejected => self::rejected($exception),
            $exception instanceof OpenWaUnavailable => new ApiProblemException(503, 'openwa_unavailable', __('OpenWA could not be reached. Check that it is running and that the address in Settings > WhatsApp is right.')),
            default => new ApiProblemException(502, 'openwa_rejected', __('OpenWA could not complete the request.')),
        };
    }

    /** OpenWA is still tearing down a deleted session of that name: the same call works in a few seconds. */
    public static function isTeardownPending(Throwable $exception): bool
    {
        return $exception instanceof OpenWaRejected && $exception->errorCode === self::TEARDOWN_PENDING;
    }

    /** One sentence for `last_error` / the connection test: what went wrong, no addresses, no keys. */
    public static function reason(Throwable $exception): string
    {
        return match (true) {
            $exception instanceof OpenWaNotConfigured => 'OpenWA is not configured.',
            $exception instanceof OpenWaAddressRefused => 'The saved OpenWA address is not allowed.',
            $exception instanceof OpenWaRejected && $exception->isUnauthorized() => 'OpenWA did not accept the API key.',
            $exception instanceof OpenWaRejected => 'OpenWA refused the request: '.mb_substr($exception->getMessage(), 0, 200),
            $exception instanceof OpenWaUnavailable => 'OpenWA could not be reached ('.mb_substr($exception->getMessage(), 0, 120).')',
            default => 'OpenWA could not complete the request.',
        };
    }

    /**
     * The machine-readable reason of the connection test: `not_configured`, `blocked`, `unauthorized`, `rejected`, `unreachable` (no
     * answer, a timeout, a 5xx) or `unexpected_response` (an answer that is not what the OpenWA API documents).
     */
    public static function testReason(Throwable $exception): string
    {
        return match (true) {
            $exception instanceof OpenWaNotConfigured => 'not_configured',
            $exception instanceof OpenWaAddressRefused => 'blocked',
            $exception instanceof OpenWaRejected => $exception->isUnauthorized() ? 'unauthorized' : 'rejected',
            $exception instanceof OpenWaUnavailable && preg_match('/^OpenWA (could not be reached|did not answer|answered HTTP)/', $exception->getMessage()) === 1 => 'unreachable',
            default => 'unexpected_response',
        };
    }

    private static function rejected(OpenWaRejected $exception): ApiProblemException
    {
        // OpenWA's own throttler (10 requests a second, 100 a minute per client address) clears in about a second.
        if ($exception->status === 429) {
            return ApiProblemException::rateLimited(__('OpenWA is busy. Try again in a moment.'), 2);
        }

        if (self::isTeardownPending($exception)) {
            return new ApiProblemException(409, 'session_name_teardown_pending', __('OpenWA is still cleaning up a session with that name. Try again in a few seconds.'));
        }

        if ($exception->isUnauthorized()) {
            return new ApiProblemException(502, 'openwa_unauthorized', __('OpenWA did not accept the API key. It may be wrong or revoked, or too limited: starting sessions and sending needs an operator or admin key that is not restricted to certain sessions.'));
        }

        return new ApiProblemException(
            502,
            'openwa_rejected',
            __('OpenWA refused the request: :reason', ['reason' => $exception->getMessage()]),
            ['code' => $exception->errorCode, 'status' => $exception->status],
        );
    }
}
