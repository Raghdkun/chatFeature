<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Result of testing an auth-portal environment. `ok` means the portal is reachable AND accepted our service credential
 * (a `token-verify` probe with a made-up token answered HTTP 200 `active:false`); latency and NATS are informative.
 * Never carries tokens.
 */
#[TypeScript]
class PortalTestResultData extends Data
{
    /**
     * @param  list<PortalCheckData>  $checks
     */
    public function __construct(
        public bool $ok,
        public array $checks,
    ) {}

    /** The message of the first failed check, trimmed to what `auth_environments.last_check_message` holds. */
    public function failureSummary(): ?string
    {
        foreach ($this->checks as $check) {
            if (! $check->ok && is_string($check->message)) {
                return mb_substr($check->message, 0, 250);
            }
        }

        return null;
    }
}
