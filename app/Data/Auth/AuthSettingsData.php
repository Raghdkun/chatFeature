<?php

namespace App\Data\Auth;

use App\Auth\Enums\AuthMode;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Props of Settings > Auth (`settings/auth`). In mode 1 (`fortify`) there is nothing to edit: `environments` is empty
 * and the page only says that sign-in is managed by this app.
 */
#[TypeScript]
class AuthSettingsData extends Data
{
    /**
     * @param  list<PizzasysEnvironmentData>  $environments  Both keys, production first (empty in mode 1).
     */
    public function __construct(
        public AuthMode $mode,
        public EnvironmentKey $active_env,
        public array $environments,
        public PizzasysRolesData $roles,
        public AuthHealthData $health,
    ) {}
}
