<?php

namespace App\Domain\WhatsApp\Realtime;

use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Models\Widget;
use Throwable;

/**
 * A session that becomes `ready` (or stops being) changes what its widgets may offer visitors: the cached availability of every widget that
 * hands over to it (`availability.whatsapp.enabled`, `config.features.whatsapp`) is dropped, so the panel stops promising a number that
 * is not there within seconds, not after the cache's lifetime.
 */
final class RefreshWidgetAvailability
{
    public function __construct(private readonly AvailabilityService $availability) {}

    public function handle(WaSessionStatusChanged $event): void
    {
        try {
            Widget::query()->where('whatsapp_session_id', $event->session->id)->get()->each(fn (Widget $widget) => $this->availability->forget($widget));
        } catch (Throwable $exception) {
            report($exception);
        }
    }
}
