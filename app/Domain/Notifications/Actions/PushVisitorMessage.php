<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushLedger;
use App\Domain\Notifications\Services\PushMessages;
use App\Domain\Notifications\Services\PushRecipients;
use App\Models\Message;

/**
 * `MessageCreated` -> a push to the agent a visitor's message is for (decision P5-D5): only a visitor's message in an `active` chat with
 * an assigned agent, only when that agent allows message pushes, is outside quiet hours and is not looking at the dashboard. A visitor
 * who sends several messages in a row notifies at most once per `push.message_throttle_seconds` (the notification is replaced by tag
 * anyway). Tag `chat-{ulid}`; the ledger lets reading the chat dismiss it on the agent's other devices.
 */
final class PushVisitorMessage
{
    public function __construct(
        private readonly PushDispatcher $push,
        private readonly PushRecipients $recipients,
        private readonly PushMessages $messages,
        private readonly PushLedger $ledger,
        private readonly NotificationPreferences $preferences,
    ) {}

    public function handle(Message $message): bool
    {
        if ($message->sender_type !== SenderType::Visitor || ! $this->push->isEnabled()) {
            return false;
        }

        $conversation = $message->conversation()->with('visitor')->first();

        if ($conversation === null || $conversation->status !== ConversationStatus::Active || $conversation->assigned_agent_id === null) {
            return false;
        }

        $recipients = $this->recipients->eligible([$conversation->assigned_agent_id], PushType::Message);

        if ($recipients === []) {
            return false;
        }

        $recipient = $recipients[0];

        if (! $this->ledger->throttle('message:'.$conversation->ulid, $recipient->user->id, (int) config('push.message_throttle_seconds', 8))) {
            return false;
        }

        $push = $this->messages->visitorMessage($conversation, $message, $recipient->user, $this->preferences->includesPreview($recipient->setting));

        $this->ledger->remember($push->tag, $recipient->user->id);

        if ($this->push->queue([$recipient->user->id], $push) === 0) {
            $this->ledger->forget($push->tag, $recipient->user->id);

            return false;
        }

        return true;
    }
}
