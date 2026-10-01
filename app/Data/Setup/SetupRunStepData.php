<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\Optional as TypeScriptOptional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Progress of one `POST /setup/run/{step}` step (migrations, seed, admin, lock). */
#[TypeScript]
class SetupRunStepData extends Data
{
    public function __construct(
        public string $key,
        public string $label,
        public SetupRunStatus $status,
        #[TypeScriptOptional]
        public string|Optional $message = new Optional,
    ) {}
}
