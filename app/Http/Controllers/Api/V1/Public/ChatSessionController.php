<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\RealtimeEndpointData;
use App\Data\Chat\SessionData;
use App\Domain\Chat\Actions\CancelQueuedConversation;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Domain\Visitors\Actions\StartSession;
use App\Domain\Visitors\VisitorTokenService;
use App\Http\Exceptions\ApiProblemException;
use App\Http\Requests\Chat\StartSessionRequest;
use App\Models\Conversation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `POST /public/widgets/{key}/sessions` (the gate chain of the public widget API ran before: unknown key, origin, limits) and
 * `DELETE /public/sessions`. The plaintext token is in the response once and never cached. `ws` is left `null` when Reverb is not
 * configured: the panel then stays on REST (the sync call `GET .../messages?after_seq=`).
 */
class ChatSessionController extends ChatVisitorController
{
    public function store(StartSessionRequest $request, StartSession $action, ReverbEndpoint $realtime): JsonResponse
    {
        $started = $action->handle($this->widget($request), $request->validated(), $request->bearerToken(), $request->userAgent(), $request->ip());

        return $this->data(SessionData::fromStarted($started, $realtime->isAvailable() ? RealtimeEndpointData::fromArray($realtime->forVisitors()) : null), 201)
            ->header('Cache-Control', 'no-store');
    }

    /**
     * Ends the visit: every active session of the visitor is revoked (a leftover token must not outlive an explicit sign-out) and a
     * chat still waiting for an agent is cancelled with it (nobody is left to answer the agents). The revocation always happens: a
     * chat an agent claimed a moment earlier is simply left running (the cancel's `409` is not this call's failure).
     */
    public function destroy(Request $request, VisitorTokenService $tokens, CancelQueuedConversation $cancel): Response
    {
        $session = $this->session($request);

        try {
            Conversation::query()
                ->where('visitor_session_id', $session->id)
                ->where('type', ConversationType::Live->value)
                ->where('status', ConversationStatus::Queued->value)
                ->get()
                ->each(function (Conversation $conversation) use ($cancel): void {
                    try {
                        $cancel->handle($conversation);
                    } catch (ApiProblemException $problem) {
                        if ($problem->errorCode() !== 'conversation_not_queued') {
                            throw $problem;
                        }
                    }
                });
        } finally {
            $tokens->revoke($session);
            $tokens->revokeAllFor($session->visitor);
        }

        return response()->noContent();
    }
}
