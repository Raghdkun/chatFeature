<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\User;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * Which WhatsApp number a widget hands visitors over to (`PUT /widgets/{ulid}/whatsapp {session}`): a live session, or none. The widget's
 * cached config and availability are dropped so the panel offers (or stops offering) the channel at once. Existing hand-off tickets stay
 * valid for the session they were made for. Audited.
 */
final class LinkWidgetSession
{
    public function __construct(
        private readonly WidgetCache $cache,
        private readonly AvailabilityService $availability,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(Widget $widget, ?string $sessionUlid, User $actor): Widget
    {
        Gate::forUser($actor)->authorize('manageSessions', WhatsAppSession::class);

        $session = null;

        if ($sessionUlid !== null) {
            $session = WhatsAppSession::query()->where('ulid', strtolower($sessionUlid))->first()
                ?? throw ValidationException::withMessages(['session' => [__('This WhatsApp session does not exist.')]]);
        }

        $widget->forceFill(['whatsapp_session_id' => $session?->id])->save();
        $widget->unsetRelation('whatsappSession');

        $this->cache->bust($widget);
        $this->availability->forget($widget);
        $this->audit->record('widget.whatsapp_linked', $widget, ['session' => $session?->ulid], $actor);

        return $widget->refresh();
    }
}
