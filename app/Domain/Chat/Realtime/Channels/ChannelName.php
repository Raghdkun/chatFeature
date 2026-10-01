<?php

namespace App\Domain\Chat\Realtime\Channels;

use Illuminate\Http\Request;

/**
 * Laravel strips `private-` / `presence-` before it matches a channel against `routes/channels.php`, so `private-staff` and
 * `presence-staff` reach the same callback. The kind a client asked for is still in the request: every channel of this application
 * exists in exactly one kind, and asking for another is refused.
 */
final class ChannelName
{
    public static function isPrivate(?Request $request = null): bool
    {
        return str_starts_with(self::requested($request), 'private-');
    }

    public static function isPresence(?Request $request = null): bool
    {
        return str_starts_with(self::requested($request), 'presence-');
    }

    private static function requested(?Request $request): string
    {
        $name = ($request ?? request())->input('channel_name');

        return is_string($name) ? $name : '';
    }
}
