<?php

namespace App\Data\Setup;

use App\Auth\Enums\AuthMode;
use App\Data\Auth\PizzasysSetupData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The `setup` prop of the `setup/index` Inertia page and the body of `GET /setup/state`
 * (`{ "setup": SetupData }`). Contract: docs/contracts/setup-wizard.md.
 *
 * `pizzasys` is non-null only when the chosen mode is `pizzasys` (docs/contracts/auth-pizzasys.md).
 */
#[TypeScript]
class SetupData extends Data
{
    /**
     * @param  list<SetupStepData>  $steps
     * @param  list<SetupRunStepData>  $run
     */
    public function __construct(
        public SetupStepKey $step,
        public array $steps,
        public bool $needsToken,
        public bool $tokenVerified,
        public ?AuthMode $mode,
        public bool $pizzasysAvailable,
        public SetupEnvironmentData $environment,
        public SetupDefaultsData $defaults,
        public ?SetupAdminData $admin,
        public array $run,
        public ?PizzasysSetupData $pizzasys = null,
    ) {}
}
