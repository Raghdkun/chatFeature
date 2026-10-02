<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Domain\Notifications\Services\PushMessages;
use App\Domain\Notifications\Support\PushMessage;
use App\Models\Conversation;
use App\Models\ConversationOffer;

/**
 * The silent `dismiss` pushes (decision P5-D5): they close the notification with a given tag on the user's devices. Only users the
 * ledger says were pushed that tag get one, so an agent who never got the OS notification is not woken for nothing.
 *
 * - `offers()`: the offer left the queue (taken by someone, cancelled by the visitor, expired): `offer-{ulid}` for the offered agents.
 * - `chat()`: the chat's message notification is obsolete (the agent read the chat, it ended, it was transferred away): `chat-{ulid}`.
 */
final class DismissPushes
{
    public function __construct(
        private readonly PushDispatcher $push,
        private readonly PushLedger $ledger,
    ) {}

    /**
     * @param  list<int>|null  $userIds  Who to close it for; null = everybody the chat was offered to.
     */
    public function offers(Conversation $conversation, ?array $userIds = null): int
    {
        if (! $this->push->isEnabled()) {
            return 0;
        }

        $userIds ??= array_values(ConversationOffer::query()->where('conversation_id', $conversation->id)->pluck('user_id')->map(fn ($id): int => (int) $id)->all());

        return $this->dismiss(PushMessages::offerTag($conversation->ulid), $userIds);
    }

    public function chat(Conversation $conversation, ?int $userId): int
    {
        if ($userId === null || ! $this->push->isEnabled()) {
            return 0;
        }

        return $this->dismiss(PushMessages::chatTag($conversation->ulid), [$userId]);
    }

    /**
     * @param  list<int>  $userIds
     */
    private function dismiss(string $tag, array $userIds): int
    {
        $targets = [];

        foreach (array_unique($userIds) as $userId) {
            if ($this->ledger->pull($tag, $userId)) {
                $targets[] = $userId;
            }
        }

        return $targets === [] ? 0 : $this->push->queue($targets, PushMessage::dismiss($tag));
    }
}
