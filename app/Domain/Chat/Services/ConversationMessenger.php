<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;

/**
 * Writes one message and keeps the conversation's counters in step (decision P4-D6). The caller holds the row lock of the
 * conversation (`lockForUpdate()` inside the transaction): that is what makes `seq = last_seq + 1` safe, and the counters,
 * `last_message_*` and the idle deadline are updated in the same transaction.
 *
 * - visitor message: `unseen_by_agent + 1`; agent message: `unseen_by_visitor + 1`; system messages touch neither counter nor
 *   the preview nor the idle deadline (only people keep a chat alive);
 * - the idle deadline moves for live chats that are `active`; offline tickets never idle out.
 */
final class ConversationMessenger
{
    public function append(
        Conversation $conversation,
        SenderType $sender,
        MessageType $type,
        ?string $body,
        ?User $agent = null,
        ?string $clientMsgId = null,
    ): Message {
        $seq = $conversation->last_seq + 1;

        $message = Message::query()->create([
            'conversation_id' => $conversation->id,
            'seq' => $seq,
            'sender_type' => $sender,
            'sender_user_id' => $sender === SenderType::Agent ? $agent?->id : null,
            'type' => $type,
            'body' => $body,
            'client_msg_id' => $clientMsgId,
        ]);

        $conversation->last_seq = $seq;

        if ($sender !== SenderType::System) {
            $now = now();

            $conversation->forceFill([
                'last_message_at' => $now,
                'last_message_preview' => MessageText::preview($body) ?? ($type === MessageType::Image ? $this->imageLabel() : null),
                'last_activity_at' => $now,
            ]);

            if ($conversation->isLive() && $conversation->status === ConversationStatus::Active) {
                $conversation->forceFill(['idle_expires_at' => $now->addMinutes(max(1, (int) $conversation->widget->idle_timeout_minutes))]);
            }

            if ($sender === SenderType::Visitor) {
                $conversation->unseen_by_agent++;
            } else {
                $conversation->unseen_by_visitor++;
            }
        }

        $conversation->save();

        return $message;
    }

    private function imageLabel(): string
    {
        $label = __('Image');

        return is_string($label) ? $label : 'Image';
    }
}
