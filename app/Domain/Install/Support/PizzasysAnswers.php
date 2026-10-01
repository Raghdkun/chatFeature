<?php

namespace App\Domain\Install\Support;

use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Roles\RoleMapping;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Crypt;
use SensitiveParameter;

/**
 * Typed read access to the mode-2 wizard answers kept in `install-state.json` (`auth_environments`):
 *
 *   environments.{production|testing}: base_url, api_prefix, service_name, service_token (Crypt-encrypted),
 *                                      nats_url, nats_token (Crypt-encrypted), verify_tls, label, tested
 *   active_env, roles{admin_permission, agent_permission, super_roles[]}
 *   portal_admin: sub, name, email, roles[], permissions[], environment (the verified portal administrator)
 *
 * Tokens are only ever stored encrypted with the application key and are decrypted in memory on demand.
 *
 * @phpstan-type EnvAnswer array{base_url: string, api_prefix: string, service_name: string, service_token: string|null, nats_url: string|null, nats_token: string|null, verify_tls: bool, label: string, tested: bool}
 * @phpstan-type PortalAdmin array{sub: string, name: string, email: string, roles: list<string>, permissions: list<string>, environment: string}
 */
final class PizzasysAnswers
{
    /**
     * @param  array<string, EnvAnswer>  $environments
     * @param  PortalAdmin|null  $portalAdmin
     */
    private function __construct(
        private readonly array $environments,
        private readonly string $activeEnv,
        private readonly RoleMapping $roles,
        private readonly ?array $portalAdmin,
    ) {}

    /**
     * @param  array<string, mixed>  $state  `auth_environments` of the install state.
     */
    public static function from(array $state): self
    {
        $environments = [];

        foreach (is_array($state['environments'] ?? null) ? $state['environments'] : [] as $key => $raw) {
            if (! is_array($raw) || ! in_array($key, ['production', 'testing'], true)) {
                continue;
            }

            if (! is_string($raw['base_url'] ?? null) || ! is_string($raw['service_name'] ?? null)) {
                continue;
            }

            $environments[$key] = [
                'base_url' => $raw['base_url'],
                'api_prefix' => is_string($raw['api_prefix'] ?? null) ? $raw['api_prefix'] : '/api/v1',
                'service_name' => $raw['service_name'],
                'service_token' => is_string($raw['service_token'] ?? null) ? $raw['service_token'] : null,
                'nats_url' => is_string($raw['nats_url'] ?? null) && $raw['nats_url'] !== '' ? $raw['nats_url'] : null,
                'nats_token' => is_string($raw['nats_token'] ?? null) && $raw['nats_token'] !== '' ? $raw['nats_token'] : null,
                'verify_tls' => ($raw['verify_tls'] ?? true) !== false,
                'label' => is_string($raw['label'] ?? null) && $raw['label'] !== '' ? $raw['label'] : ucfirst($key),
                'tested' => ($raw['tested'] ?? false) === true,
            ];
        }

        $active = $state['active_env'] ?? 'production';
        $roles = is_array($state['roles'] ?? null) ? $state['roles'] : [];
        $admin = is_array($state['portal_admin'] ?? null) ? $state['portal_admin'] : null;

        return new self(
            $environments,
            is_string($active) && isset($environments[$active]) ? $active : 'production',
            new RoleMapping(
                is_string($roles['admin_permission'] ?? null) && $roles['admin_permission'] !== '' ? $roles['admin_permission'] : 'chat.admin',
                is_string($roles['agent_permission'] ?? null) && $roles['agent_permission'] !== '' ? $roles['agent_permission'] : 'chat.agent',
                is_array($roles['super_roles'] ?? null) ? array_values(array_filter($roles['super_roles'], 'is_string')) : ['super-admin'],
            ),
            $admin !== null && is_string($admin['sub'] ?? null) && is_string($admin['email'] ?? null) && is_string($admin['name'] ?? null)
                ? [
                    'sub' => $admin['sub'],
                    'name' => $admin['name'],
                    'email' => $admin['email'],
                    'roles' => array_values(array_filter(is_array($admin['roles'] ?? null) ? $admin['roles'] : [], 'is_string')),
                    'permissions' => array_values(array_filter(is_array($admin['permissions'] ?? null) ? $admin['permissions'] : [], 'is_string')),
                    'environment' => is_string($admin['environment'] ?? null) ? $admin['environment'] : 'production',
                ]
                : null,
        );
    }

    /** The production environment (and, if given, the testing one) have a URL, a service name and a token. */
    public function isConfigured(): bool
    {
        $active = $this->environments[$this->activeEnv] ?? null;

        return isset($this->environments['production']) && $active !== null && $active['service_token'] !== null;
    }

    /**
     * @return array<string, EnvAnswer>
     */
    public function environments(): array
    {
        return $this->environments;
    }

    /**
     * @return EnvAnswer|null
     */
    public function environment(string $key): ?array
    {
        return $this->environments[$key] ?? null;
    }

    public function activeKey(): string
    {
        return $this->activeEnv;
    }

    public function roles(): RoleMapping
    {
        return $this->roles;
    }

    /**
     * @return PortalAdmin|null
     */
    public function portalAdmin(): ?array
    {
        return $this->portalAdmin;
    }

    public function tested(string $key): bool
    {
        return ($this->environments[$key]['tested'] ?? false) === true;
    }

    /** The decrypted connection details of one environment; null when missing or the stored token cannot be read. */
    public function endpoint(string $key): ?PizzasysEndpoint
    {
        $environment = $this->environments[$key] ?? null;
        $token = $environment !== null ? self::decrypt($environment['service_token']) : null;

        if ($environment === null || $token === null) {
            return null;
        }

        return new PizzasysEndpoint($key, $environment['base_url'], $environment['api_prefix'], $environment['service_name'], $token, $environment['verify_tls']);
    }

    public function natsToken(string $key): ?string
    {
        return self::decrypt($this->environments[$key]['nats_token'] ?? null);
    }

    public static function encrypt(#[SensitiveParameter] string $plain): string
    {
        return Crypt::encryptString($plain);
    }

    private static function decrypt(?string $payload): ?string
    {
        if ($payload === null || $payload === '') {
            return null;
        }

        try {
            return Crypt::decryptString($payload);
        } catch (DecryptException) {
            return null;
        }
    }
}
