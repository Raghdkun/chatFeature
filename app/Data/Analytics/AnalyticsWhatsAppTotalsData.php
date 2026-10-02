<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** WhatsApp numbers of a range (administrators only). `linkedShare` = chats matched to a widget visitor by a hand-off / chats created, 0-1. */
#[TypeScript]
class AnalyticsWhatsAppTotalsData extends Data
{
    public function __construct(
        public int $chats,
        public int $linkedChats,
        public ?float $linkedShare,
        public int $inbound,
        public int $outbound,
        public ?float $averageResponseSeconds,
        public int $responseCount,
    ) {}
}
