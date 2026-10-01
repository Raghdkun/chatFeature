<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\RoutingStatus;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Offer a new chat to agents with these presence statuses once `afterSeconds` have passed. */
#[TypeScript]
class RoutingWaveData extends Data
{
    /**
     * @param  array<int, RoutingStatus>  $statuses
     */
    public function __construct(
        public int $afterSeconds,
        public array $statuses,
    ) {}

    /**
     * Spatie casts lists of Data objects but not lists of enums, so the statuses are mapped here.
     *
     * @param  array<string, mixed>  $properties
     * @return array<string, mixed>
     */
    public static function prepareForPipeline(array $properties): array
    {
        $statuses = $properties['statuses'] ?? [];
        $properties['statuses'] = array_values(array_filter(array_map(
            static fn (mixed $status): ?RoutingStatus => $status instanceof RoutingStatus ? $status : (is_string($status) ? RoutingStatus::tryFrom($status) : null),
            is_array($statuses) ? $statuses : [],
        )));

        return $properties;
    }
}
