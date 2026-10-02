<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Ratings given in the range: `distribution` holds the counts of 1, 2, 3, 4 and 5 stars in that order. */
#[TypeScript]
class AnalyticsRatingsData extends Data
{
    /**
     * @param  list<int>  $distribution
     */
    public function __construct(
        public int $count,
        public ?float $average,
        public array $distribution,
    ) {}
}
