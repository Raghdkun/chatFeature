<?php

namespace App\Auth\Pizzasys\Actions;

use App\Auth\Enums\AuthMode;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\NatsHealth;
use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PortalHealth;
use App\Auth\Roles\RoleMapping;
use App\Data\Auth\AuthHealthData;
use App\Data\Auth\AuthNatsHealthData;
use App\Data\Auth\AuthSettingsData;
use App\Data\Auth\EnvironmentKey;
use App\Data\Auth\PizzasysEnvironmentData;
use App\Data\Auth\PizzasysRolesData;
use App\Data\Auth\PortalHealthStatus;
use App\Domain\Settings\SettingsRepository;

/** Props of Settings > Auth. Contains no secrets: only `has_*_token` flags. */
final class BuildAuthSettingsData
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuthEnvironmentRepository $environments,
        private readonly PortalHealth $health,
        private readonly PizzasysCircuitBreaker $breaker,
        private readonly NatsHealth $nats,
    ) {}

    public function __invoke(): AuthSettingsData
    {
        $mode = AuthMode::tryFrom($this->settings->string('auth.mode', 'fortify')) ?? AuthMode::Fortify;
        $roles = RoleMapping::fromSettings($this->settings);
        $rolesData = new PizzasysRolesData($roles->adminPermission, $roles->agentPermission, $roles->superRoles);

        if ($mode !== AuthMode::Pizzasys) {
            return new AuthSettingsData(
                $mode,
                EnvironmentKey::Production,
                [],
                $rolesData,
                new AuthHealthData(PortalHealthStatus::Unknown, false, null, new AuthNatsHealthData(false, null, null)),
            );
        }

        $stored = $this->environments->all();
        $active = $this->environments->activeKey();
        $natsEnabled = $this->settings->bool('auth.pizzasys.nats.enabled');

        return new AuthSettingsData(
            $mode,
            EnvironmentKey::from($active),
            [
                PizzasysEnvironmentData::fromModel(EnvironmentKey::Production, $stored->get('production')),
                PizzasysEnvironmentData::fromModel(EnvironmentKey::Testing, $stored->get('testing')),
            ],
            $rolesData,
            new AuthHealthData(
                PortalHealthStatus::from($this->health->status($active)),
                $this->breaker->isOpen($active),
                $this->health->lastVerifyAt($active)?->toIso8601String(),
                new AuthNatsHealthData($natsEnabled, $natsEnabled ? $this->nats->connected() : null, $natsEnabled ? $this->nats->lastEventAt() : null),
                $this->health->serviceRejection($active) !== null,
            ),
        );
    }
}
