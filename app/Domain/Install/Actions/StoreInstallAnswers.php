<?php

namespace App\Domain\Install\Actions;

use App\Auth\Roles\RoleMapping;
use App\Domain\Install\InstallState;
use App\Domain\Install\Support\PizzasysAnswers;
use Illuminate\Support\Facades\Hash;

/**
 * Persists the wizard answers into install-state.json (no database involved).
 * Shared by the wizard's form posts and by `chat:install`. The admin password is hashed on the
 * way in; the plain text is never written anywhere.
 */
final class StoreInstallAnswers
{
    public function __construct(private readonly InstallState $state) {}

    /**
     * Changing an answer invalidates the run steps that consumed it, so a wizard that was resumed
     * (or that went back a screen) re-runs them instead of keeping stale results.
     */
    public function mode(string $mode): void
    {
        $this->state->mutate(function (array $state) use ($mode): array {
            $state['mode'] = $mode;

            return $this->forgetRuns($state, ['seed-defaults', 'create-admin', 'write-lock']);
        });
    }

    public function admin(string $name, string $email, string $plainPassword): void
    {
        $hash = Hash::make($plainPassword);

        $this->state->mutate(function (array $state) use ($name, $email, $hash): array {
            $state['admin'] = ['name' => $name, 'email' => mb_strtolower($email), 'password_hash' => $hash];

            return $this->forgetRuns($state, ['create-admin', 'write-lock']);
        });
    }

    /**
     * Mode 2: the portal environments, the active one and the role mapping. A token left out (null) keeps the one
     * already stored for that environment; new tokens are encrypted with the application key before they are written.
     * Any change drops the connection-test results and the verified portal administrator, which were proven against
     * the old answers.
     *
     * @param  array<string, array{base_url: string, api_prefix?: string, service_name: string, service_token: string|null, nats_url: string|null, nats_token: string|null, nats_token_clear?: bool, verify_tls: bool, label?: string}|null>  $environments  Keyed production|testing; a null or missing testing entry removes it.
     */
    public function pizzasys(array $environments, string $activeEnv, RoleMapping $roles): void
    {
        $this->state->mutate(function (array $state) use ($environments, $activeEnv, $roles): array {
            $previous = PizzasysAnswers::from($state['auth_environments']);
            $stored = [];

            foreach (['production', 'testing'] as $key) {
                $input = $environments[$key] ?? null;

                if ($input === null) {
                    continue;
                }

                $before = $previous->environment($key);

                $stored[$key] = [
                    'base_url' => rtrim($input['base_url'], '/'),
                    'api_prefix' => $input['api_prefix'] ?? '/api/v1',
                    'service_name' => $input['service_name'],
                    'service_token' => $input['service_token'] !== null && $input['service_token'] !== ''
                        ? PizzasysAnswers::encrypt($input['service_token'])
                        : ($before['service_token'] ?? null),
                    'nats_url' => $input['nats_url'] !== null && $input['nats_url'] !== '' ? $input['nats_url'] : null,
                    // No NATS URL, no NATS token; otherwise an empty token keeps the stored one.
                    'nats_token' => $input['nats_url'] === null || $input['nats_url'] === '' || ($input['nats_token_clear'] ?? false) === true
                        ? null
                        : ($input['nats_token'] !== null && $input['nats_token'] !== '' ? PizzasysAnswers::encrypt($input['nats_token']) : ($before['nats_token'] ?? null)),
                    'verify_tls' => $input['verify_tls'],
                    'label' => $input['label'] ?? ucfirst($key),
                    'tested' => false,
                ];
            }

            $state['auth_environments'] = [
                'environments' => $stored,
                'active_env' => $activeEnv,
                'roles' => [
                    'admin_permission' => $roles->adminPermission,
                    'agent_permission' => $roles->agentPermission,
                    'super_roles' => $roles->superRoles,
                ],
                'portal_admin' => null,
            ];

            return $this->forgetRuns($state, ['seed-defaults', 'create-admin', 'write-lock']);
        });
    }

    /** Remember whether the last connection test of an environment passed. */
    public function markTested(string $environment, bool $ok): void
    {
        $this->state->mutate(function (array $state) use ($environment, $ok): array {
            if (isset($state['auth_environments']['environments'][$environment])) {
                $state['auth_environments']['environments'][$environment]['tested'] = $ok;
            }

            return $state;
        });
    }

    /**
     * The portal administrator whose login was verified in this wizard run (identity and roles, never a token or password).
     *
     * @param  list<string>  $roles
     * @param  list<string>  $permissions
     */
    public function portalAdmin(string $environment, string $sub, string $name, string $email, array $roles, array $permissions): void
    {
        $this->state->mutate(function (array $state) use ($environment, $sub, $name, $email, $roles, $permissions): array {
            $state['auth_environments']['portal_admin'] = [
                'sub' => $sub,
                'name' => $name,
                'email' => mb_strtolower($email),
                'roles' => $roles,
                'permissions' => $permissions,
                'environment' => $environment,
            ];

            return $this->forgetRuns($state, ['create-admin', 'write-lock']);
        });
    }

    /**
     * @param  array{app_name: string, app_url: string, locale: string, timezone: string, idle_timeout_minutes: int}  $basics
     */
    public function basics(array $basics): void
    {
        $this->state->mutate(function (array $state) use ($basics): array {
            $state['basics'] = $basics;

            return $this->forgetRuns($state, ['seed-defaults', 'write-lock']);
        });
    }

    /**
     * @param  array<string, mixed>  $state
     * @param  list<string>  $keys
     * @return array<string, mixed>
     */
    private function forgetRuns(array $state, array $keys): array
    {
        foreach ($keys as $key) {
            unset($state['run'][$key]);
        }

        return $state;
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
