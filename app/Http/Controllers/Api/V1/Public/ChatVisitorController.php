<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Http\Controllers\Controller;
use App\Models\Conversation;
use App\Models\VisitorSession;
use App\Models\Widget;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Spatie\LaravelData\Data;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Base of the visitor chat endpoints (behind `visitor` and `EnsureVisitorWidgetActive`): the session and widget the middleware
 * resolved, the `{ulid}` check (a conversation that is not this session's is `404`, never `403`) and the `{ data }` envelope.
 */
abstract class ChatVisitorController extends Controller
{
    protected function session(Request $request): VisitorSession
    {
        $session = $request->attributes->get('visitor_session');

        if (! $session instanceof VisitorSession) {
            throw new NotFoundHttpException;
        }

        return $session;
    }

    protected function widget(Request $request): Widget
    {
        $widget = $request->attributes->get('widget');

        if (! $widget instanceof Widget) {
            throw new NotFoundHttpException;
        }

        return $widget;
    }

    /** The conversation `$ulid` of THIS session, or 404. */
    protected function conversation(Request $request, string $ulid): Conversation
    {
        $session = $this->session($request);

        $conversation = Conversation::query()
            ->with(['category', 'assignedAgent'])
            ->where('ulid', $ulid)
            ->where('visitor_session_id', $session->id)
            ->where('visitor_id', $session->visitor_id)
            ->first();

        if ($conversation === null) {
            throw new NotFoundHttpException;
        }

        return $conversation;
    }

    /**
     * @param  Data|array<array-key, mixed>|null  $payload
     */
    protected function data(Data|array|null $payload, int $status = 200): JsonResponse
    {
        return response()->json(['data' => $payload instanceof Data ? $payload->toArray() : $payload], $status);
    }
}
