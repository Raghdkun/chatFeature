<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Data\Chat\ConversationPublicData;
use App\Domain\Chat\Actions\CancelQueuedConversation;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Domain\Visitors\Actions\StartSession;
use App\Domain\Visitors\VisitorTokenService;
use App\Domain\Widgets\Support\Timestamps;
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
        $started = $action->handle($this->widget($request), $request->validated(), $request->bearerToken(), $request->userAgent());

        return $this->data([
            'visitorToken' => $started->token->plaintext,
            'expiresAt' => Timestamps::iso($started->token->session->expires_at),
            'conversation' => $started->conversation === null ? null : ConversationPublicData::fromModel($started->conversation)->toArray(),
            'ws' => $realtime->isAvailable() ? $realtime->forVisitors() : null,
        ], 201)->header('Cache-Control', 'no-store');
    }

    /** Revokes the token. A chat still waiting for an agent is cancelled with it (nobody is left to answer the agents). */
    public function destroy(Request $request, VisitorTokenService $tokens, CancelQueuedConversation $cancel): Response
    {
        $session = $this->session($request);

        Conversation::query()
            ->where('visitor_session_id', $session->id)
            ->where('type', ConversationType::Live->value)
            ->where('status', ConversationStatus::Queued->value)
            ->get()
            ->each(fn (Conversation $conversation) => $cancel->handle($conversation));

        $tokens->revoke($session);

        return response()->noContent();
    }
}
