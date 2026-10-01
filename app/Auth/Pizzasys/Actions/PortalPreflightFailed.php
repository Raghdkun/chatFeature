<?php

namespace App\Auth\Pizzasys\Actions;

use App\Data\Auth\PortalTestResultData;
use RuntimeException;

/** The settings of the ACTIVE environment would not have worked: nothing was saved. Carries the failing checks. */
final class PortalPreflightFailed extends RuntimeException
{
    public function __construct(public readonly PortalTestResultData $result)
    {
        parent::__construct('The portal did not accept the submitted settings.');
    }
}
