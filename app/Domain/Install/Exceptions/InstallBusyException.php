<?php

namespace App\Domain\Install\Exceptions;

use RuntimeException;

/** Another install run holds the `install.running` flock. */
final class InstallBusyException extends RuntimeException
{
    public function __construct()
    {
        parent::__construct('Another installation run is already in progress.');
    }
}
