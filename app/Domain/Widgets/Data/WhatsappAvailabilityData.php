<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** WhatsApp hand-off availability (always disabled until P6 connects a session). */
#[TypeScript]
class WhatsappAvailabilityData extends Data
{
    public function __construct(
        public bool $enabled = false,
    ) {}
}
