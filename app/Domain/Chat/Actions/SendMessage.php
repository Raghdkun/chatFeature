<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Services\ConversationMessenger;
use App\Domain\Chat\Services\MessageText;
use App\Domain\Chat\Services\SentMessage;
use App\Http\Exceptions\ApiProblemException;
use App\Mail\OfflineTicketReply;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Mail;
use Illuminate\Validation\ValidationException;

/**
 * A visitor or an agent writes a message (decision P4-D6).
 *
 * Under the row lock of the conversation: a repeated `client_msg_id` returns the original message (`created = false`, answered
 * `200`), the chat must be `active` (`409 conversation_not_active`), referenced attachments are claimed (they must have been
 * uploaded to this conversation by the same side and not used yet), `seq` is `last_seq + 1`, and the counters, `last_message_*`
 * and the idle deadline move in the same transaction (`ConversationMessenger`). Events fire after the commit. A staff reply on
 * an offline ticket is also e-mailed to the visitor (queued), because the visitor is gone.
 *
 * Callers authorise first (`ConversationAccess` for staff, the session ownership for visitors); visitors may only write in live chats.
 */
final class SendMessage
{
    public const MAX_ATTACHMENTS = 5;

    public function __construct(private readonly ConversationMessenger $messenger) {}

    /**
     * @param  list<string>  $attachmentUlids
     */
    public function handle(
        Conversation $conversation,
        SenderType $sender,
        ?User $agent,
        ?string $body,
        array $attachmentUlids = [],
        ?string $clientMsgId = null,
    ): SentMessage {
        $body = MessageText::clean($body);
        $attachmentUlids = array_values(array_unique($attachmentUlids));

        if ($body === null && $attachmentUlids === []) {
            throw ValidationException::withMessages(['body' => [__('Please write a message or attach an image.')]]);
        }

        if ($clientMsgId !== null && ($existing = $this->existing($conversation, $clientMsgId)) !== null) {
            return new SentMessage($existing, false);
        }

        try {
            [$message, $created] = DeadlockRetry::transaction(fn (): array => $this->write($conversation, $sender, $agent, $body, $attachmentUlids, $clientMsgId));
        } catch (UniqueConstraintViolationException $exception) {
            // A parallel retry of the same `client_msg_id` won the unique index: that one is the original.
            $existing = $clientMsgId === null ? null : $this->existing($conversation, $clientMsgId);

            if ($existing === null) {
                throw $exception;
            }

            return new SentMessage($existing, false);
        }

        $message->load(['conversation.visitor', 'senderUser', 'attachments']);

        if ($created) {
            $this->announce($message, $sender);
        }

        return new SentMessage($message, $created);
    }

    /**
     * @param  list<string>  $attachmentUlids
     * @return array{0: Message, 1: bool}
     */
    private function write(Conversation $conversation, SenderType $sender, ?User $agent, ?string $body, array $attachmentUlids, ?string $clientMsgId): array
    {
        $locked = Conversation::query()->with('widget')->whereKey($conversation->id)->lockForUpdate()->firstOrFail();

        if ($clientMsgId !== null && ($existing = $this->existing($locked, $clientMsgId)) !== null) {
            return [$existing, false];
        }

        if ($locked->status !== ConversationStatus::Active) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        if ($sender === SenderType::Visitor && $locked->type !== ConversationType::Live) {
            throw ApiProblemException::conflict('conversation_not_active', __('This chat is not active.'));
        }

        $attachments = $this->claimableAttachments($locked, $sender, $agent, $attachmentUlids);

        $message = $this->messenger->append(
            $locked,
            $sender,
            $attachments === [] ? MessageType::Text : MessageType::Image,
            $body,
            $agent,
            $clientMsgId,
        );

        if ($attachments !== []) {
            Attachment::query()->whereKey(array_map(static fn (Attachment $attachment): int => $attachment->id, $attachments))->update(['message_id' => $message->id]);
        }

        return [$message, true];
    }

    /**
     * The attachments the message references, which must belong to this conversation, come from the same side and not be in use.
     *
     * @param  list<string>  $ulids
     * @return list<Attachment>
     */
    private function claimableAttachments(Conversation $conversation, SenderType $sender, ?User $agent, array $ulids): array
    {
        if ($ulids === []) {
            return [];
        }

        $found = Attachment::query()
            ->where('conversation_id', $conversation->id)
            ->whereNull('message_id')
            ->where('uploader_type', $sender->value)
            ->when($sender === SenderType::Agent, fn ($query) => $query->where('uploader_user_id', $agent?->id))
            ->whereIn('ulid', $ulids)
            ->lockForUpdate()
            ->get();

        if ($found->count() !== count($ulids)) {
            throw ValidationException::withMessages(['attachments' => [__('One of the attachments cannot be used.')]]);
        }

        return array_values($found->all());
    }

    private function existing(Conversation $conversation, string $clientMsgId): ?Message
    {
        return Message::query()->where('conversation_id', $conversation->id)->where('client_msg_id', $clientMsgId)->first();
    }

    private function announce(Message $message, SenderType $sender): void
    {
        $conversation = $message->conversation;
        $conversation->load(['category', 'assignedAgent', 'widget']);

        MessageCreated::dispatch($message);

        if ($sender === SenderType::Visitor) {
            UnseenCountChanged::dispatch($conversation);
        }

        ConversationUpdated::dispatch($conversation);

        if ($sender === SenderType::Agent && $conversation->type === ConversationType::Offline) {
            $this->mailReply($conversation, $message);
        }
    }

    /** The visitor of an offline ticket is not in the widget any more: the reply goes to their e-mail address. */
    private function mailReply(Conversation $conversation, Message $message): void
    {
        $email = $conversation->visitor->email;

        if (is_string($email) && $email !== '') {
            Mail::to($email)->queue(new OfflineTicketReply($conversation, $message));
        }
    }
}
