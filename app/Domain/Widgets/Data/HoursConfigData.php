<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\OfflineMode;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `config.hours`. `mode` and `timezone` mirror the `widgets.offline_mode` / `widgets.timezone` columns,
 * which are authoritative (the resolver overlays them). The default schedule is Monday to Friday, 09:00 to 17:00.
 */
#[TypeScript]
class HoursConfigData extends Data
{
    /**
     * @param  array<int, ScheduleRangeData>  $schedule
     * @param  array<int, HolidayData>  $holidays
     */
    public function __construct(
        public OfflineMode $mode = OfflineMode::AutoHours,
        public string $timezone = 'UTC',
        public array $schedule = [
            new ScheduleRangeData(1, '09:00', '17:00'),
            new ScheduleRangeData(2, '09:00', '17:00'),
            new ScheduleRangeData(3, '09:00', '17:00'),
            new ScheduleRangeData(4, '09:00', '17:00'),
            new ScheduleRangeData(5, '09:00', '17:00'),
        ],
        public array $holidays = [],
    ) {}
}
