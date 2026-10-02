<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** WhatsApp hand-off availability: true when `whatsapp.enabled`, the widget's `features.whatsapp` and a `ready` linked session all hold (P6). Never carries the number. */
#[TypeScript]
class WhatsappAvailabilityData extends Data
{
    public function __construct(
        public bool $enabled = false,
    ) {}
}
