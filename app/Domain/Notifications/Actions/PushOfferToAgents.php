<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Domain\Notifications\Services\PushMessages;
use App\Domain\Notifications\Services\PushRecipients;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use Carbon\CarbonInterface;
use Illuminate\Support\Collection;

/**
 * `ChatOffered` -> an OS push to each offered agent who should get one (decision P5-D5): offers still open, the chat still waiting, the
 * agent allows offer pushes, is outside quiet hours and is not looking at the dashboard. The push is queued; each recipient is noted in
 * the ledger so the silent dismiss that follows (`DismissPushes`) reaches exactly them. Tag `offer-{ulid}`, TTL = the offer's remaining
 * time, urgency high.
 */
final class PushOfferToAgents
{
    public function __construct(
        private readonly PushDispatcher $push,
        private readonly PushRecipients $recipients,
        private readonly PushMessages $messages,
        private readonly PushLedger $ledger,
        private readonly NotificationPreferences $preferences,
    ) {}

    /**
     * @param  Collection<int, ConversationOffer>  $offers
     */
    public function handle(Conversation $conversation, Collection $offers, CarbonInterface $expiresAt): int
    {
        if (! $this->push->isEnabled()) {
            return 0;
        }

        $current = Conversation::query()->with(['category', 'visitor'])->find($conversation->id);

        // Claimed, cancelled or expired between the event and now: nothing to ring for.
        if ($current === null || $current->status !== ConversationStatus::Queued || ! $expiresAt->isFuture()) {
            return 0;
        }

        $offered = $offers->pluck('user_id')->map(fn ($id): int => (int) $id)->all();
        $stillOpen = array_values(ConversationOffer::query()
            ->where('conversation_id', $current->id)
            ->whereIn('user_id', $offered)
            ->open()
            ->pluck('user_id')
            ->map(fn ($id): int => (int) $id)
            ->all());

        $queued = 0;

        foreach ($this->recipients->eligible($stillOpen, PushType::Offer) as $recipient) {
            $message = $this->messages->offer($current, $recipient->user, $this->preferences->includesPreview($recipient->setting), $expiresAt);

            if ($this->push->queue([$recipient->user->id], $message) > 0) {
                $this->ledger->remember($message->tag, $recipient->user->id);
                $queued++;
            }
        }

        return $queued;
    }
}
