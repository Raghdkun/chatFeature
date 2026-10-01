<?php

use App\Domain\Settings\SettingsRepository;

if (! function_exists('settings')) {
    /**
     * Read a setting (`settings('auth.mode')`), or get the repository when called without a key.
     * Returns defaults without touching the database until the app is installed.
     *
     * @return ($key is null ? SettingsRepository : mixed)
     */
    function settings(?string $key = null, mixed $default = null): mixed
    {
        $repository = app(SettingsRepository::class);

        return $key === null ? $repository : $repository->get($key, $default);
    }
}
