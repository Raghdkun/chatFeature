<?php

namespace App\Domain\Install\Actions;

use App\Auth\Pizzasys\PizzasysClient;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Domain\Install\InstallState;
use App\Domain\Install\Support\PizzasysAnswers;
use SensitiveParameter;

/**
 * Wizard (mode 2): the person finishing the setup must be able to sign in through the portal AND map to administrator,
 * so nobody locks themselves out. The login goes through the raw client (live answers, no cache) against the active
 * environment of the wizard answers, with the wizard's own role mapping. The upstream token is used for the check only
 * and closed again; the verified identity (never the password or a token) is kept in the install state.
 *
 * @phpstan-type Outcome array{ok: true, name: string, email: string}|array{ok: false, code: 'invalid'|'unavailable'|'no_chat_access'|'not_admin'|'not_configured', message: string}
 */
final class VerifyPortalAdmin
{
    public function __construct(
        private readonly InstallState $state,
        private readonly PizzasysClient $client,
        private readonly PizzasysRoleResolver $roles,
        private readonly StoreInstallAnswers $answers,
    ) {}

    /**
     * @return Outcome
     */
    public function __invoke(string $email, #[SensitiveParameter] string $password): array
    {
        $answers = PizzasysAnswers::from($this->state->read()['auth_environments']);
        $key = $answers->activeKey();
        $endpoint = $answers->endpoint($key);

        if (! $answers->isConfigured() || $endpoint === null) {
            return ['ok' => false, 'code' => 'not_configured', 'message' => __('Save the portal settings first.')];
        }

        $login = $this->client->login($endpoint, $email, $password);

        if ($login->status === PortalStatus::Invalid) {
            return ['ok' => false, 'code' => 'invalid', 'message' => __('The portal did not accept that email and password.')];
        }

        if (! $login->isOk() || $login->token === null) {
            return ['ok' => false, 'code' => 'unavailable', 'message' => PortalFailure::message($login->reason)];
        }

        $token = $login->token;
        $verify = $this->client->verify($endpoint, $token);

        // The token was only needed for this check, and upstream tokens never expire on their own.
        $this->client->logout($endpoint, $token);

        if ($verify->status === PortalStatus::ServiceRejected) {
            return ['ok' => false, 'code' => 'unavailable', 'message' => __('The portal rejected the service credentials. Check the service name and token.')];
        }

        if (! $verify->isActive() || $verify->claims === null) {
            return ['ok' => false, 'code' => 'unavailable', 'message' => PortalFailure::message($verify->reason)];
        }

        $claims = $verify->claims;
        $mapping = $answers->roles();
        $decision = $this->roles->decide($claims->roles, $claims->permissions, $mapping);

        if (! $decision->hasChatAccess()) {
            return ['ok' => false, 'code' => 'no_chat_access', 'message' => __('That account has no chat role in the portal. Use an administrator account.')];
        }

        if (! $decision->isAdmin) {
            return ['ok' => false, 'code' => 'not_admin', 'message' => __('That account is not an administrator. Use an account with the ":permission" permission or a super role, so you can manage the app afterwards.', ['permission' => $mapping->adminPermission])];
        }

        $this->answers->portalAdmin($key, $claims->sub, $claims->name, $claims->email, $claims->roles, $claims->permissions);
        $this->answers->markTested($key, true);

        return ['ok' => true, 'name' => $claims->name, 'email' => mb_strtolower($claims->email)];
    }
}
