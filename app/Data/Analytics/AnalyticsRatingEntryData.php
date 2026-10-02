<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One recent rating with its comment (administrators only: agents get the numbers, never the visitors' words). */
#[TypeScript]
class AnalyticsRatingEntryData extends Data
{
    public function __construct(
        public string $conversation,
        public int $score,
        public ?string $comment,
        public string $createdAt,
        public ?string $widget,
        public ?string $category,
        public ?string $agent,
    ) {}
}
