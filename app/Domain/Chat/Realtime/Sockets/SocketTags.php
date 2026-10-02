<?php

namespace App\Domain\Chat\Realtime\Sockets;

/**
 * The tag a websocket carries so the server can close it again (docs/realtime.md "Cutting a socket off").
 *
 * Reverb has exactly one control surface for closing sockets: the Pusher HTTP call `POST /apps/{id}/users/{userId}/terminate_connections`,
 * which closes every connection whose subscription carried `user_id = {userId}` in its signed `channel_data`. Channel authorisation signs
 * `{"user_id": <tag>}` into every PRIVATE subscription (a client cannot drop or change it: the signature covers it), so a revoked actor is
 * found by tag whatever channels the socket joined. The tag is an HMAC of the principal under the application key, never the id itself:
 * `client-typing` whispers are re-broadcast WITH the sender's `user_id`, and a visitor must not learn an agent's integer id (or an
 * agent a visitor's session id) from the frames of a conversation channel.
 *
 * The one exception is `presence-staff`: Laravel signs the member's id there (the roster is keyed by it), so a staff member's sockets
 * carry either their opaque tag or their plain id, depending on which subscription Reverb reads first. `allForStaff()` therefore names both.
 */
final class SocketTags
{
    /** A staff member on a private channel. */
    public static function staff(int $userId): string
    {
        return 's_'.self::digest('staff:'.$userId);
    }

    /** A staff member as the roster (`presence-staff`) knows them: Laravel's broadcast identifier, the user id. */
    public static function staffPresence(int $userId): string
    {
        return (string) $userId;
    }

    /**
     * Every tag a staff member's sockets can carry.
     *
     * @return list<string>
     */
    public static function allForStaff(int $userId): array
    {
        return [self::staff($userId), self::staffPresence($userId)];
    }

    /** One visitor session (one bearer token). Another token of the same visitor has another tag. */
    public static function visitorSession(int $sessionId): string
    {
        return 'v_'.self::digest('visitor-session:'.$sessionId);
    }

    private static function digest(string $value): string
    {
        return substr(hash_hmac('sha256', $value, (string) config('app.key')), 0, 24);
    }
}
