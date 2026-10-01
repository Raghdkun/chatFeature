<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The `setup.pizzasys` block of the wizard (only present when the chosen mode is `pizzasys`). Comes from the
 * install state: never tokens.
 */
#[TypeScript]
class PizzasysSetupData extends Data
{
    public function __construct(
        public PizzasysEnvironmentsData $environments,
        public EnvironmentKey $active_env,
        public PizzasysRolesData $roles,
        public PizzasysTestedData $tested,
        public ?PizzasysPortalAdminData $portal_admin,
    ) {}
}
