<?php

namespace App\Domain\Install\Actions;

use App\Domain\Install\InstallState;
use Illuminate\Support\Facades\Hash;

/**
 * Persists the wizard answers into install-state.json (no database involved).
 * Shared by the wizard's form posts and by `chat:install`. The admin password is hashed on the
 * way in; the plain text is never written anywhere.
 */
final class StoreInstallAnswers
{
    public function __construct(private readonly InstallState $state) {}

    public function mode(string $mode): void
    {
        $this->state->mutate(function (array $state) use ($mode): array {
            $state['mode'] = $mode;

            return $state;
        });
    }

    public function admin(string $name, string $email, string $plainPassword): void
    {
        $hash = Hash::make($plainPassword);

        $this->state->mutate(function (array $state) use ($name, $email, $hash): array {
            $state['admin'] = ['name' => $name, 'email' => mb_strtolower($email), 'password_hash' => $hash];

            return $state;
        });
    }

    /**
     * @param  array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}  $basics
     */
    public function basics(array $basics): void
    {
        $this->state->mutate(function (array $state) use ($basics): array {
            $state['basics'] = $basics;

            return $state;
        });
    }

    /**
     * Wizard defaults for the "basics" form.
     *
     * @return array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}
     */
    public static function defaultBasics(): array
    {
        $locale = config('app.locale');
        $url = config('app.url');
        $timezone = config('install.defaults.timezone');
        $idle = config('install.defaults.idle_timeout_minutes');
        $name = config('app.name');

        return [
            'app_name' => is_string($name) && $name !== '' ? $name : 'PNE Chat',
            'app_url' => is_string($url) && $url !== '' ? $url : 'http://localhost',
            'locale' => is_string($locale) && $locale !== '' ? $locale : 'en',
            'timezone' => is_string($timezone) && $timezone !== '' ? $timezone : 'UTC',
            'idle_timeout_minutes' => is_numeric($idle) ? (int) $idle : 120,
        ];
    }
}
