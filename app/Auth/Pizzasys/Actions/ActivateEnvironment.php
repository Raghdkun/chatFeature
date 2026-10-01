<?php

namespace App\Auth\Pizzasys\Actions;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Models\User;
use SensitiveParameter;

/**
 * Switch the active auth environment (production <-> testing) from the dashboard.
 *
 * Safety net against locking everyone out: the admin must be able to sign in on the TARGET environment, with a portal
 * account that maps to administrator there. That login (and its upstream token) is used for the check only and is
 * closed again. Only then does {@see SwitchActiveEnvironment} flip the setting and revoke the other environment's
 * sessions, the actor's included.
 */
final class ActivateEnvironment
{
    public function __construct(
        private readonly AuthEnvironmentRepository $environments,
        private readonly PizzasysClient $client,
        private readonly PizzasysRoleResolver $roles,
        private readonly SwitchActiveEnvironment $switch,
    ) {}

    public function __invoke(User $actor, string $key, string $email, #[SensitiveParameter] string $password): ActivationResult
    {
        $target = $this->environments->find($key);
        $endpoint = $target?->endpoint();

        if ($target === null || $endpoint === null) {
            return ActivationResult::failed('not_configured', __('That environment is not configured yet.'));
        }

        if ($key === $this->environments->activeKey()) {
            return ActivationResult::failed('already_active', __('That environment is already the active one.'));
        }

        $login = $this->client->login($endpoint, $email, $password);

        if ($login->status === PortalStatus::Invalid) {
            return ActivationResult::failed('invalid', __('The portal on :env did not accept those credentials.', ['env' => $target->label]));
        }

        if (! $login->isOk() || $login->token === null) {
            return ActivationResult::failed('unavailable', PortalFailure::message($login->reason));
        }

        $token = $login->token;

        $verify = $this->client->verify($endpoint, $token);

        // Only needed for this check; upstream tokens never expire, so close it again.
        $this->client->logout($endpoint, $token);

        if ($verify->status === PortalStatus::ServiceRejected) {
            return ActivationResult::failed('service_rejected', __('The portal on :env rejected this application\'s service credentials.', ['env' => $target->label]));
        }

        if (! $verify->isActive() || $verify->claims === null) {
            return ActivationResult::failed('unavailable', PortalFailure::message($verify->reason));
        }

        if (! $this->roles->decide($verify->claims->roles, $verify->claims->permissions)->isAdmin) {
            return ActivationResult::failed('not_admin', __('That account is not an administrator on :env. Use an account that is, so you cannot lock yourself out.', ['env' => $target->label]));
        }

        ($this->switch)($target, $actor, 'dashboard');

        return ActivationResult::activated();
    }
}
