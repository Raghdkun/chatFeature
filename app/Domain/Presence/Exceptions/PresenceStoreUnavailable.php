<?php

namespace App\Domain\Presence\Exceptions;

use RuntimeException;
use Throwable;

/** The service behind a presence store (Redis) cannot be reached or refused a command. */
final class PresenceStoreUnavailable extends RuntimeException
{
    public static function because(Throwable $previous): self
    {
        return new self('The presence store is unavailable: '.$previous->getMessage(), 0, $previous);
    }
}
