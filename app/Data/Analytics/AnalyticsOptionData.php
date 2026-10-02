<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A choice of a filter menu: `key` is the widget / topic ulid or the agent's user id (as text). `deleted` = soft-deleted: old numbers still point at it. */
#[TypeScript]
class AnalyticsOptionData extends Data
{
    public function __construct(
        public string $key,
        public string $label,
        public bool $deleted,
    ) {}
}
