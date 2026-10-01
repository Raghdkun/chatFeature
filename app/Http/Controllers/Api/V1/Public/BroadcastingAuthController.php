<?php

namespace App\Http\Controllers\Api\V1\Public;

use App\Http\Controllers\Controller;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\VisitorSession;
use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Broadcasting\BroadcastManager;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * `POST /api/v1/public/broadcasting/auth`: the Pusher channel authorisation of a VISITOR (bearer `vt_...` through the `visitor`
 * middleware, form fields `socket_id` and `channel_name`, exactly what `pusher-js` posts). The only channel a visitor may join is
 * `private-conversation.{ulid}` of the conversation their session is bound to; anything else (another visitor's conversation, an
 * unknown ulid, any other channel name) is `403`, never `404`, because that is what a Pusher client expects of a refusal.
 *
 * The signature comes from the configured broadcaster (the Reverb app secret never leaves the server), the response is not
 * cacheable and sets no cookie (the route lives in the bearer-only `widget` group). Staff use the standard `/broadcasting/auth`.
 */
class BroadcastingAuthController extends Controller
{
    /** The named rate limiter (D10), registered by RealtimeServiceProvider. */
    public const LIMITER = 'broadcasting-auth';

    /** What Reverb issues as a socket id: two integers joined by a dot. */
    private const SOCKET_ID = '/^\d{1,12}\.\d{1,12}$/D';

    public function __invoke(Request $request, BroadcastManager $broadcasting): JsonResponse
    {
        $request->validate([
            'socket_id' => ['required', 'string', 'regex:'.self::SOCKET_ID],
            'channel_name' => ['required', 'string', 'max:100'],
        ]);

        $session = $request->attributes->get('visitor_session');

        if (! $session instanceof VisitorSession || ! $this->mayJoin($session, (string) $request->input('channel_name'))) {
            throw ApiProblemException::forbidden('channel_forbidden', __('You cannot join this channel.'));
        }

        $broadcaster = $broadcasting->connection();

        if (! $broadcaster instanceof PusherBroadcaster) {
            throw new ApiProblemException(503, 'realtime_unavailable', __('Live updates are not available right now.'));
        }

        return response()
            ->json($broadcaster->validAuthenticationResponse($request, true))
            ->header('Cache-Control', 'no-store, private');
    }

    private function mayJoin(VisitorSession $session, string $channel): bool
    {
        // Exactly the name events are published to: ulids are lower case here, and no other spelling of the channel gets a signature.
        if (preg_match('/^private-conversation\.([0-9a-z]{26})$/D', $channel, $matches) !== 1 || ! Str::isUlid($matches[1])) {
            return false;
        }

        $conversation = Conversation::query()->where('ulid', $matches[1])->first();

        return $conversation !== null && $session->owns($conversation);
    }
}
