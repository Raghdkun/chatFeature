<?php

namespace App\Domain\Chat\Realtime\Support;

use App\Domain\Chat\Realtime\Sockets\SocketTags;
use App\Models\User;
use App\Models\VisitorSession;
use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Broadcasting\BroadcastException;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Throwable;

/**
 * The Reverb broadcaster of this application: Laravel's Pusher broadcaster, except that a failed publish no longer carries the
 * request URL in its message. The Pusher client signs every publish in the query string (`auth_key`, `auth_signature`,
 * `body_md5`), the HTTP client puts that URL into its error text ("... for http://reverb:8080/apps/1/events?auth_signature=..."),
 * and the failure is reported to the log: a signed request must not end up in log files.
 *
 * It also signs the principal into every PRIVATE channel subscription (`channel_data` = `{"user_id": <tag>}`, see `SocketTags`): that is
 * what lets Reverb's `terminate_connections` close the sockets of a revoked staff member or visitor session
 * (docs/realtime.md, "Cutting a socket off"). Presence channels already carry the member's id.
 */
final class RedactedReverbBroadcaster extends PusherBroadcaster
{
    /**
     * @param  array<int, mixed>  $channels
     * @param  array<string, mixed>  $payload
     */
    public function broadcast(array $channels, $event, array $payload = []): void
    {
        try {
            parent::broadcast($channels, $event, $payload);
        } catch (Throwable $exception) {
            throw new BroadcastException(self::redact($exception->getMessage()));
        }
    }

    /**
     * @param  Request  $request
     * @param  mixed  $result
     */
    public function validAuthenticationResponse($request, $result)
    {
        $channel = (string) $request->channel_name;

        if (! str_starts_with($channel, 'private') || ! config('broadcasting.realtime.tag_private_channels', true)) {
            return parent::validAuthenticationResponse($request, $result);
        }

        $tag = $this->principalTag($request, $channel);

        // A private channel nobody can be named for could never be closed again: it is not signed.
        if ($tag === null) {
            throw new AccessDeniedHttpException;
        }

        return $this->decodePusherResponse(
            $request,
            $this->pusher->authorizeChannel($channel, (string) $request->socket_id, json_encode(['user_id' => $tag], JSON_THROW_ON_ERROR)),
        );
    }

    /** The visitor session the `visitor` middleware resolved, else the staff member the channel's guards resolve. */
    private function principalTag(Request $request, string $channel): ?string
    {
        $session = $request->attributes->get('visitor_session');

        if ($session instanceof VisitorSession) {
            return SocketTags::visitorSession($session->id);
        }

        $user = $this->retrieveUser($request, $this->normalizeChannelName($channel));

        return $user instanceof User ? SocketTags::staff($user->id) : null;
    }

    /** Everything after the `?` of a URL is dropped. */
    public static function redact(string $message): string
    {
        return (string) preg_replace('/\?[^\s"\')]*/', '?…', $message);
    }
}
