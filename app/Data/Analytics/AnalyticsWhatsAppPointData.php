<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One bucket of the WhatsApp series. */
#[TypeScript]
class AnalyticsWhatsAppPointData extends Data
{
    public function __construct(
        public string $date,
        public int $chats,
        public int $inbound,
        public int $outbound,
        public ?float $averageResponseSeconds,
    ) {}
}
