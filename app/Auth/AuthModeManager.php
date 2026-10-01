<?php

namespace App\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Drivers\FortifyDriver;
use Illuminate\Support\Manager;
use RuntimeException;

/**
 * Resolves the active AuthDriver from `settings('auth.mode')`. Before the app is installed the
 * setting is not read from the database: it resolves `fortify`.
 *
 * P2 adds `createPizzasysDriver()`.
 */
final class AuthModeManager extends Manager
{
    public function getDefaultDriver(): string
    {
        $mode = settings('auth.mode', 'fortify');

        return is_string($mode) && $mode !== '' ? $mode : 'fortify';
    }

    /** The driver for the configured mode. */
    public function activeDriver(): AuthDriver
    {
        $driver = $this->driver();

        if (! $driver instanceof AuthDriver) {
            throw new RuntimeException('The resolved auth driver does not implement '.AuthDriver::class.'.');
        }

        return $driver;
    }

    protected function createFortifyDriver(): AuthDriver
    {
        return $this->container->make(FortifyDriver::class);
    }
}
