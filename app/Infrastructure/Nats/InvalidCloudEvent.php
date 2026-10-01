<?php

namespace App\Infrastructure\Nats;

use InvalidArgumentException;

/**
 * A NATS message body that is not an acceptable CloudEvents envelope. The message only ever carries a
 * short reason code, never a fragment of the payload (payloads can contain password hashes).
 */
final class InvalidCloudEvent extends InvalidArgumentException
{
    public const NOT_JSON = 'not_json';

    public const NOT_AN_OBJECT = 'not_an_object';

    public const TOO_LARGE = 'too_large';

    public const UNSUPPORTED_SPECVERSION = 'unsupported_specversion';

    public const MISSING_ID = 'missing_id';

    public const MISSING_TYPE = 'missing_type';

    public function __construct(public readonly string $reason)
    {
        parent::__construct('Invalid CloudEvent: '.$reason);
    }
}
