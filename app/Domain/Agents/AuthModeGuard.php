<?php

namespace App\Domain\Agents;

use App\Auth\Enums\AuthMode;
use App\Domain\Settings\SettingsRepository;
use App\Http\Exceptions\ApiProblemException;

/**
 * Staff accounts are only editable here in mode 1 (local Fortify auth). In mode 2 the pizzasys portal owns
 * accounts, activation and roles; the dashboard may only adjust chat-specific settings.
 */
final class AuthModeGuard
{
    public function __construct(private readonly SettingsRepository $settings) {}

    public function mode(): AuthMode
    {
        return AuthMode::tryFrom($this->settings->string('auth.mode', AuthMode::Fortify->value)) ?? AuthMode::Fortify;
    }

    public function canManageStaff(): bool
    {
        return $this->mode() === AuthMode::Fortify;
    }

    /**
     * @throws ApiProblemException 409 `managed_by_auth_portal`
     */
    public function requireManageable(): void
    {
        if (! $this->canManageStaff()) {
            throw ApiProblemException::conflict('managed_by_auth_portal', __('Accounts and roles are managed in the authentication portal.'));
        }
    }
}
