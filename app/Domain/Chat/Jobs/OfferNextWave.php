<?php

namespace App\Domain\Chat\Jobs;

use App\Domain\Chat\Actions\OfferToAgents;
use App\Models\Conversation;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * A later routing wave (for example the `away` agents after 20 s). `$notBefore` is the unix time the wave is due: a queue that
 * runs delayed jobs at once (the sync driver) must not offer a chat to wave 2 early (the `chat:offer-waves` sweep makes the wave
 * once it is due). `$epoch` is the conversation's `claim_version` when the job was dispatched: after a transfer / re-queue the chat
 * is in a later epoch and this job is a no-op. A failed run is retried a few times; the sweep is the net under that.
 */
final class OfferNextWave implements ShouldQueue
{
    use Queueable;

    /** Seconds the due time may lie ahead of the clock (queue timestamps are whole seconds). */
    private const TOLERANCE_SECONDS = 2;

    public int $tries = 3;

    public function __construct(
        public readonly int $conversationId,
        public readonly int $wave,
        public readonly int $notBefore,
        public readonly ?int $epoch = null,
    ) {}

    /**
     * @return list<int>
     */
    public function backoff(): array
    {
        return [3, 10];
    }

    public function handle(OfferToAgents $offers): void
    {
        if (now()->getTimestamp() + self::TOLERANCE_SECONDS < $this->notBefore) {
            return;
        }

        $conversation = Conversation::query()->find($this->conversationId);

        if ($conversation !== null) {
            $offers->wave($conversation, $this->wave, $this->epoch);
        }
    }
}
