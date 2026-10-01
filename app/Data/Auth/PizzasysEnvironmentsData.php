<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Both environments, configured or not (wizard payload). */
#[TypeScript]
class PizzasysEnvironmentsData extends Data
{
    public function __construct(
        public PizzasysEnvironmentData $production,
        public PizzasysEnvironmentData $testing,
    ) {}
}
