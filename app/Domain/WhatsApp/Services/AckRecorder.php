<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Support\Payload;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;

/**
 * `message.ack` / `message.failed`: `{id, messageId, status, ack}` with no chat id. The message is found by its WhatsApp id among the
 * chats of THIS session (an ack of another session's message is not ours to apply) and moves forward only
 * (`WaMessageStatus::advance`): acks arrive late, twice and out of order, a delivered message cannot fail and nothing goes back. The
 * write is a single guarded `UPDATE ... WHERE status IN (the statuses that may advance to the new one)`, so a racing ack cannot be undone
 * by a stale read. An ack faster than the send job's own bookkeeping is retried later by the delivery job ({@see AckBeforeMessage}).
 */
final class AckRecorder
{
    private const FAILURE_TEXT = 'WhatsApp reported that the message could not be delivered.';

    private const ATTEMPTS = 3;

    /**
     * @param  array<array-key, mixed>  $data
     *
     * @throws AckBeforeMessage
     */
    public function record(WhatsAppSession $session, array $data, string $event): WebhookResult
    {
        // `id` and `messageId` are both in the payload and whether they are the same value is unverified: try both.
        $candidates = array_values(array_unique(array_filter(
            [Payload::string($data, 'messageId', 129), Payload::string($data, 'id', 129)],
            static fn (?string $id): bool => $id !== null && strlen($id) <= 128,
        )));

        if ($candidates === []) {
            return WebhookResult::ignored('The ack names no message.');
        }

        $incoming = $event === 'message.failed'
            ? WaMessageStatus::Failed
            : (WaMessageStatus::fromOpenWa(Payload::string($data, 'status', 16)) ?? (is_numeric($data['ack'] ?? null) ? WaMessageStatus::fromAck((int) $data['ack']) : null));

        if ($incoming === null) {
            return WebhookResult::ignored('The ack carries no known status.');
        }

        for ($attempt = 1; $attempt <= self::ATTEMPTS; $attempt++) {
            $message = $this->find($session, $candidates);

            if ($message === null) {
                throw new AckBeforeMessage('No message with this id yet.');
            }

            $from = $message->status;

            if ($from->advance($incoming) === $from) {
                return WebhookResult::processed();
            }

            $affected = WaMessage::query()
                ->whereKey($message->id)
                ->whereIn('status', $this->statusesBefore($incoming))
                ->update([
                    'status' => $incoming->value,
                    'error' => $incoming === WaMessageStatus::Failed ? self::FAILURE_TEXT : $message->error,
                    'updated_at' => now(),
                ]);

            if ($affected === 1) {
                WaMessageStatusChanged::dispatch($message->refresh(), $from);

                return WebhookResult::processed();
            }
        }

        return WebhookResult::processed();
    }

    /**
     * @param  list<string>  $waMessageIds
     */
    private function find(WhatsAppSession $session, array $waMessageIds): ?WaMessage
    {
        return WaMessage::query()
            ->select('wa_messages.*')
            ->join('wa_chats', 'wa_chats.id', '=', 'wa_messages.wa_chat_id')
            ->where('wa_chats.session_id', $session->id)
            ->whereIn('wa_messages.wa_message_id', $waMessageIds)
            ->orderBy('wa_messages.id')
            ->first();
    }

    /**
     * The statuses a message may be in for `$to` to be a step forward.
     *
     * @return list<string>
     */
    private function statusesBefore(WaMessageStatus $to): array
    {
        return array_values(array_map(
            static fn (WaMessageStatus $status): string => $status->value,
            array_filter(WaMessageStatus::cases(), static fn (WaMessageStatus $status): bool => $status->canAdvanceTo($to)),
        ));
    }
}
