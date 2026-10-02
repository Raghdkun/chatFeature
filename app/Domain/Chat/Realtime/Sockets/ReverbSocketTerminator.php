<?php

namespace App\Domain\Chat\Realtime\Sockets;

use App\Domain\Chat\Realtime\Support\RedactedReverbBroadcaster;
use Illuminate\Broadcasting\Broadcasters\PusherBroadcaster;
use Illuminate\Broadcasting\BroadcastException;
use Illuminate\Broadcasting\BroadcastManager;
use Throwable;

/**
 * Reverb's own control API: `POST /apps/{id}/users/{tag}/terminate_connections` (signed like a publish, so it needs the same
 * credentials and the same internal address). With several Reverb instances (`REVERB_SCALING_ENABLED`) the instance that gets the call
 * publishes it on Redis and every instance closes its matching sockets. With any other broadcaster (not installed yet, Reverb not
 * configured) no websocket can exist and the call is a no-op.
 */
final class ReverbSocketTerminator implements SocketTerminator
{
    public function __construct(private readonly BroadcastManager $broadcasts) {}

    public function terminate(string $tag): void
    {
        $broadcaster = $this->broadcasts->connection();

        if (! $broadcaster instanceof PusherBroadcaster) {
            return;
        }

        try {
            $broadcaster->getPusher()->terminateUserConnections($tag);
        } catch (Throwable $exception) {
            // The signed URL of the call is part of the client's message: it never reaches a log.
            throw new BroadcastException(RedactedReverbBroadcaster::redact($exception->getMessage()), previous: null);
        }
    }
}
