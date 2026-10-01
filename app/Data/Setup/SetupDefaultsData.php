<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Pre-filled values of the "basics" form (or the answers already given). */
#[TypeScript]
class SetupDefaultsData extends Data
{
    public function __construct(
        public string $app_name,
        public string $app_url,
        public string $locale,
        public string $timezone,
        public int $idle_timeout_minutes,
    ) {}
}
