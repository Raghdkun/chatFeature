<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Whether the last connection test of each wizard environment passed. */
#[TypeScript]
class PizzasysTestedData extends Data
{
    public function __construct(
        public bool $production,
        public bool $testing,
    ) {}
}
