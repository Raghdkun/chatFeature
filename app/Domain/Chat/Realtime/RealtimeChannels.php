<?php

namespace App\Domain\Chat\Realtime;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PresenceChannel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * The channels of docs/contracts/realtime-events.md, the only place their names are spelled. `PrivateChannel` / `PresenceChannel`
 * add the `private-` / `presence-` prefix the Pusher protocol (and so `routes/channels.php`) expects.
 */
final class RealtimeChannels
{
    public static function staff(int $userId): PrivateChannel
    {
        return new PrivateChannel('staff.'.$userId);
    }

    public static function presenceStaff(): PresenceChannel
    {
        return new PresenceChannel('staff');
    }

    public static function conversation(string $ulid): PrivateChannel
    {
        return new PrivateChannel('conversation.'.$ulid);
    }

    public static function admin(): PrivateChannel
    {
        return new PrivateChannel('admin');
    }

    /**
     * The `staff.{id}` channel of each user.
     *
     * @param  iterable<int>  $userIds
     * @return list<Channel>
     */
    public static function staffMany(iterable $userIds): array
    {
        $channels = [];

        foreach ($userIds as $userId) {
            $channels[$userId] = self::staff($userId);
        }

        return array_values($channels);
    }
}
