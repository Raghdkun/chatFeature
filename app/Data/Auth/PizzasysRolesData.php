<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** How portal roles/permissions map to chat roles. */
#[TypeScript]
class PizzasysRolesData extends Data
{
    /**
     * @param  list<string>  $super_roles
     */
    public function __construct(
        public string $admin_permission,
        public string $agent_permission,
        public array $super_roles,
    ) {}
}
