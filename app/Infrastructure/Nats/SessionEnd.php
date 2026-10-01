<?php

namespace App\Infrastructure\Nats;

/**
 * Why a connected consumer session ended without an error.
 */
enum SessionEnd
{
    /** Stop requested, `--once` drained or `--max-messages` reached: leave the run loop. */
    case Finished;

    /** The restart signal changed: reconnect straight away with freshly read settings. */
    case Restart;
}
