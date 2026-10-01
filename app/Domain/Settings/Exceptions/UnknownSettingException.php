<?php

namespace App\Domain\Settings\Exceptions;

use InvalidArgumentException;

final class UnknownSettingException extends InvalidArgumentException
{
    public function __construct(string $key)
    {
        parent::__construct("Unknown setting [{$key}]. Register it with SettingsRegistry::define().");
    }
}
