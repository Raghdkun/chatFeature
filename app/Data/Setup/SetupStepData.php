<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One entry of the wizard's progress header. */
#[TypeScript]
class SetupStepData extends Data
{
    public function __construct(
        public SetupStepKey $key,
        public string $label,
        public SetupStepStatus $status,
    ) {}
}
