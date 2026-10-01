<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A closed day (`date` is `YYYY-MM-DD` in the widget's timezone; `label` is `''` when the admin gave none, never null). */
#[TypeScript]
class HolidayData extends Data
{
    public function __construct(
        public string $date,
        public string $label = '',
    ) {}
}
