<?php

namespace App\Data\Privacy;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET|PUT /privacy/retention`: how many days closed conversations are kept (0 = for ever) and the shortest retention that is accepted. */
#[TypeScript]
class RetentionData extends Data
{
    public function __construct(
        public int $days,
        public int $minimumDays,
    ) {}
}
