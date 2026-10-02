<?php

namespace App\Domain\Chat\Realtime\Sockets;

/**
 * Closes every websocket that carries a tag (`SocketTags`). The one production implementation asks Reverb; tests bind a recording one.
 */
interface SocketTerminator
{
    /**
     * @throws \Throwable when Reverb could not be asked (the caller retries); asking for a tag nobody carries is not an error
     */
    public function terminate(string $tag): void;
}
