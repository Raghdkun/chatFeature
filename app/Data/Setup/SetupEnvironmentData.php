<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

#[TypeScript]
class SetupEnvironmentData extends Data
{
    /**
     * @param  list<SetupCheckData>  $checks
     */
    public function __construct(
        public bool $ok,
        public array $checks,
    ) {}
}
