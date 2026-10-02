<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\WhatsApp\WidgetWhatsAppLinkData;
use App\Domain\WhatsApp\Actions\LinkWidgetSession;
use App\Http\Requests\WhatsApp\LinkWidgetRequest;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

/** `GET/PUT /widgets/{ulid}/whatsapp`: which WhatsApp session a widget hands visitors over to (administrators only, like all of WhatsApp). */
class WidgetWhatsAppController extends WhatsAppController
{
    public function show(Request $request, Widget $widget): JsonResponse
    {
        Gate::forUser($this->admin($request))->authorize('manageSessions', WhatsAppSession::class);

        return $this->data(WidgetWhatsAppLinkData::fromWidget($widget->loadMissing('whatsappSession')));
    }

    public function update(LinkWidgetRequest $request, Widget $widget, LinkWidgetSession $action): JsonResponse
    {
        $updated = $action->handle($widget, $request->sessionUlid(), $this->admin($request));

        return $this->data(WidgetWhatsAppLinkData::fromWidget($updated->loadMissing('whatsappSession')));
    }
}
