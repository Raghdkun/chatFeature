<?php

namespace App\Auth\Roles;

use App\Domain\Settings\SettingsRepository;

/**
 * How portal roles/permissions translate into chat roles (settings `auth.pizzasys.{admin_permission,
 * agent_permission,super_roles}`).
 */
final readonly class RoleMapping
{
    /**
     * @param  list<string>  $superRoles  A portal role in this list makes its holder an administrator.
     */
    public function __construct(
        public string $adminPermission = 'chat.admin',
        public string $agentPermission = 'chat.agent',
        public array $superRoles = ['super-admin'],
    ) {}

    public static function fromSettings(SettingsRepository $settings): self
    {
        $supers = $settings->get('auth.pizzasys.super_roles', ['super-admin']);

        return new self(
            $settings->string('auth.pizzasys.admin_permission', 'chat.admin'),
            $settings->string('auth.pizzasys.agent_permission', 'chat.agent'),
            is_array($supers) ? array_values(array_filter($supers, 'is_string')) : ['super-admin'],
        );
    }
}
