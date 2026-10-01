<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * A `PayloadBroadcast` published inside the dispatching process instead of through the queue: `message.created`, `chat.claimed`
 * and `session.revoked` (latency matters), and the per-audience events of the queue-count job (already a queued job).
 */
final class ImmediatePayloadBroadcast extends PayloadBroadcast implements ShouldBroadcastNow {}
