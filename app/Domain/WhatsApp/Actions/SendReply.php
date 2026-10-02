<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Chat\Services\MessageText;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Jobs\SendWhatsAppMessage;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Support\Database\DeadlockRetry;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * An administrator replies to a WhatsApp chat (`POST /whatsapp/chats/{ulid}/messages`, decision P6-D5). The request only STORES the reply
 * (status `pending`) and queues {@see SendWhatsAppMessage}; OpenWA is called by the job, which also paces the sends.
 *
 * Checked here, in this order, under guarded code (the policy says who; these say when):
 *  - the text: plain, 1 to 4096 characters after cleaning (control and bidi characters dropped);
 *  - a repeated `client_msg_id` of this chat returns the ORIGINAL (`created = false`, answered 200), never a second message;
 *  - the chat's session is `ready` (`409 session_not_ready`);
 *  - `whatsapp.reply_only_to_inbound`: only chats the customer started (`409 reply_not_allowed`): a number that writes to people who
 *    never wrote to it is what gets banned;
 *  - the daily cap of the session (`429 daily_cap_reached`, `Retry-After` until 00:00 UTC): an atomic counter, taken in the same
 *    transaction as the row, so a rejected or repeated request never uses a slot.
 */
final class SendReply
{
    public const MAX_LENGTH = 4096;

    public function __construct(
        private readonly SendCounter $counter,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @return array{message: WaMessage, created: bool}
     */
    public function handle(WaChat $chat, User $actor, string $body, ?string $clientMsgId = null): array
    {
        Gate::forUser($actor)->authorize('reply', $chat);

        $text = MessageText::clean($body);

        if ($text === null) {
            throw ValidationException::withMessages(['body' => [__('Please write a message.')]]);
        }

        if (mb_strlen($text) > self::MAX_LENGTH) {
            throw ValidationException::withMessages(['body' => [__('A WhatsApp message can have at most :max characters.', ['max' => self::MAX_LENGTH])]]);
        }

        if ($clientMsgId !== null && ($existing = $this->existing($chat, $clientMsgId)) !== null) {
            return ['message' => $existing, 'created' => false];
        }

        try {
            $message = DeadlockRetry::transaction(fn (): WaMessage => $this->store($chat, $actor, $text, $clientMsgId));
        } catch (UniqueConstraintViolationException $exception) {
            // A parallel request with the same `client_msg_id` won the unique index: that one is the original (this one took no slot).
            $existing = $clientMsgId === null ? null : $this->existing($chat, $clientMsgId);

            if ($existing === null) {
                throw $exception;
            }

            return ['message' => $existing, 'created' => false];
        }

        $this->audit->record('whatsapp.message.sent', $message, ['chat' => $chat->ulid, 'length' => mb_strlen($text)], $actor);
        WaMessageSent::dispatch($message->load('chat'));
        $this->queue($message);

        return ['message' => $message->refresh(), 'created' => true];
    }

    private function store(WaChat $chat, User $actor, string $text, ?string $clientMsgId): WaMessage
    {
        $locked = WaChat::query()->with('session')->lockForUpdate()->findOrFail($chat->id);
        $session = $locked->session;

        if ($session->trashed() || $session->status !== SessionStatus::Ready || $session->openwa_session_id === null) {
            throw new ApiProblemException(409, 'session_not_ready', __('The WhatsApp number is not connected right now.'), ['status' => $session->trashed() ? 'deleted' : $session->status->value]);
        }

        if (settings()->bool('whatsapp.reply_only_to_inbound', true) && ! $locked->inbound_initiated) {
            throw ApiProblemException::conflict('reply_not_allowed', __('This customer has not written to you first, so you cannot message them from here.'));
        }

        if (! $this->counter->reserve($session)) {
            $seconds = $this->counter->secondsUntilReset();

            throw new ApiProblemException(
                429,
                'daily_cap_reached',
                __('This WhatsApp number has reached its daily limit of :cap messages. It starts over at 00:00 UTC.', ['cap' => $session->dailySendCap()]),
                ['cap' => $session->dailySendCap(), 'retry_after' => $seconds],
                ['Retry-After' => (string) $seconds],
            );
        }

        $message = WaMessage::query()->create([
            'wa_chat_id' => $locked->id,
            'direction' => WaDirection::Out,
            'client_msg_id' => $clientMsgId,
            'type' => WaMessageType::Text,
            'body' => $text,
            'sent_by_user_id' => $actor->id,
            'status' => WaMessageStatus::Pending,
            // Announced by the reply's own `WaMessageSent`: the echo of this message must never be announced a second time.
            'announced_at' => now(),
            'wa_timestamp' => now(),
        ]);

        $at = now()->format('Y-m-d H:i:s');
        WaChat::query()->whereKey($locked->id)->where(fn ($query) => $query->whereNull('last_message_at')->orWhere('last_message_at', '<=', $at))->update([
            'last_message_at' => $at,
            'last_message_preview' => MessageText::preview($text, 160),
        ]);
        WaChat::query()->whereKey($locked->id)->where('status', 'archived')->update(['status' => 'open', 'updated_at' => now()]);

        return $message;
    }

    /** Hand the stored reply to the worker; a queue that cannot take it fails the reply at once (and gives its slot back). */
    private function queue(WaMessage $message): void
    {
        try {
            SendWhatsAppMessage::dispatch($message->id);
        } catch (Throwable $exception) {
            report($exception);

            $failed = WaMessage::query()->whereKey($message->id)->where('status', WaMessageStatus::Pending->value)->update([
                'status' => WaMessageStatus::Failed->value,
                'error' => 'The message could not be queued for sending.',
                'updated_at' => now(),
            ]);

            if ($failed === 1) {
                $this->counter->release($message->chat->session_id, $message->created_at ?? now());
            }

            throw new ApiProblemException(503, 'queue_unavailable', __('The message could not be queued. Please try again.'));
        }
    }

    private function existing(WaChat $chat, string $clientMsgId): ?WaMessage
    {
        return WaMessage::query()->where('wa_chat_id', $chat->id)->where('client_msg_id', $clientMsgId)->first();
    }
}
