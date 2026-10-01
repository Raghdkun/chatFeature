<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\PresenceData;
use App\Domain\Presence\PresenceService;
use App\Domain\Widgets\Support\Timestamps;
use App\Http\Requests\Chat\SetPresenceRequest;
use App\Models\AgentPresence;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `GET/PUT /me/presence` and `POST /me/presence/heartbeat`: the caller's own presence. `GET` / `PUT` report the effective status
 * (a stored `online` whose heartbeat is older than 90 s reads as `offline`, exactly as routing treats it); clients beat every 30 s.
 */
class ChatPresenceController extends ChatStaffController
{
    public function show(Request $request, PresenceService $presence): JsonResponse
    {
        return $this->present($presence, $presence->current($this->staff($request)));
    }

    public function update(SetPresenceRequest $request, PresenceService $presence): JsonResponse
    {
        return $this->present($presence, $presence->set($this->staff($request), $request->status()));
    }

    public function heartbeat(Request $request, PresenceService $presence): Response
    {
        $presence->heartbeat($this->staff($request));

        return response()->noContent();
    }

    private function present(PresenceService $service, AgentPresence $presence): JsonResponse
    {
        return $this->data(new PresenceData(
            userId: $presence->user_id,
            status: $service->effectiveStatus($presence),
            isManual: $presence->is_manual,
            lastSeenAt: Timestamps::iso($presence->last_seen_at),
        ));
    }
}
