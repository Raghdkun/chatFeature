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

/**
 * `GET/PUT /me/presence` and `POST /me/presence/heartbeat {visible?}`: the caller's own presence. All three report the effective
 * status (silence and auto-away included, exactly as routing treats it) as `{data: {userId, status, isManual, lastSeenAt}}`; clients beat
 * every 30 s and say whether their tab is visible, and the answer to a beat is how a dashboard whose record the store lost (Redis was
 * flushed, a long sleep) learns at once that the server now reads it as `offline` (a heartbeat never revives a lost record).
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

    public function heartbeat(HeartbeatRequest $request, PresenceService $presence): JsonResponse
    {
        return $this->present($presence, $presence->heartbeat($this->staff($request), $request->visible()));
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
