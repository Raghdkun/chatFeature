<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Chat\PresenceData;
use App\Domain\Presence\PresenceService;
use App\Domain\Widgets\Support\Timestamps;
use App\Http\Requests\Chat\HeartbeatRequest;
use App\Http\Requests\Chat\SetPresenceRequest;
use App\Models\AgentPresence;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `GET/PUT /me/presence` and `POST /me/presence/heartbeat {visible?}`: the caller's own presence. `GET` / `PUT` report the effective
 * status (silence and auto-away included, exactly as routing treats it); clients beat every 30 s and say whether their tab is visible.
 */
class ChatPresenceController extends ChatStaffController
{
    public function show(Request $request, PresenceService $presence): JsonResponse
    {
        return $this->present($presence, $presence->current($this->staff($request)));
    }

    public function update(SetPresenceRequest $request, PresenceService $presence): JsonResponse
    {
        return $this->present($presence, $presence->set($this->staff($request), $request->status(), $request->automatic()));
    }

    public function heartbeat(HeartbeatRequest $request, PresenceService $presence): Response
    {
        $presence->heartbeat($this->staff($request), $request->visible());

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
