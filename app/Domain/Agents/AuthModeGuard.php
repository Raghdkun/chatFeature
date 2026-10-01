<?php

namespace App\Domain\Agents;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use App\Http\Exceptions\ApiProblemException;
use RuntimeException;

/**
 * Staff accounts are only editable here in mode 1 (local Fortify auth). In mode 2 the pizzasys portal owns
 * accounts, activation and roles; the dashboard may only adjust chat-specific settings.
 *
 * Fails closed: once the installation is complete, a missing or unrecognised `auth.mode` setting is a broken
 * installation, not "mode 1" (treating it as Fortify would let admins create local accounts that bypass the portal).
 * Every method then throws `500 auth_mode_unavailable` and the problem is reported.
 */
final class AuthModeGuard
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly InstallState $install,
    ) {}

    /**
     * @throws ApiProblemException 500 `auth_mode_unavailable`
     */
    public function mode(): AuthMode
    {
        // Before the installation is complete there is nothing to guard: the wizard still decides the mode.
        if (! $this->install->isInstalled()) {
            return AuthMode::Fortify;
        }

        $mode = $this->settings->has('auth.mode') ? AuthMode::tryFrom($this->settings->string('auth.mode')) : null;

        if ($mode === null) {
            report(new RuntimeException('The `auth.mode` setting is missing or invalid on an installed instance; refusing to guess the authentication mode.'));

            throw new ApiProblemException(500, 'auth_mode_unavailable', __('The authentication mode is not configured. Run the setup again or contact the administrator.'));
        }

        return $mode;
    }

    public function canManageStaff(): bool
    {
        return $this->mode() === AuthMode::Fortify;
    }

    /**
     * @throws ApiProblemException 409 `managed_by_auth_portal`, 500 `auth_mode_unavailable`
     */
    public function requireManageable(): void
    {
        if (! $this->canManageStaff()) {
            throw ApiProblemException::conflict('managed_by_auth_portal', __('Accounts and roles are managed in the authentication portal.'));
        }
    }
}
