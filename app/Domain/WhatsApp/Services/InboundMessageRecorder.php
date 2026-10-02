<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\Chat\Services\MessageText;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Support\ChatId;
use App\Domain\WhatsApp\Support\Payload;
use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Support\Database\DeadlockRetry;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * `message.received` and `message.sent` (docs/reference/openwa-api.md 6.6): the message object becomes a `wa_messages` row of a
 * `wa_chats` row, tolerantly (the raw object is kept; unknown fields, unknown types and missing optional fields never fail a delivery).
 *
 *  - Only a person's chat is recorded: stories, channels and broadcast lists are ignored, groups follow `whatsapp.ignore_groups`.
 *  - The chat id is normalised (`@s.whatsapp.net` and `@c.us` are one customer). A `@lid` chat takes its number from `senderPhone`.
 *  - `fromMe` (and every `message.sent`) is the phone's own send or the echo of a reply this application made: direction out, no unread.
 *    An echo is matched to the pending reply it belongs to, never recorded twice; a customer who writes first sets `inbound_initiated`.
 *  - Ordering and repeats are safe: the unique `(wa_chat_id, wa_message_id)` index through `INSERT IGNORE` decides who stores the row
 *    (the second delivery of one message, even under another idempotency key, is a `duplicate`); the chat's counters move in the same
 *    transaction as the row, `last_message_*` only forward in time.
 *  - An image is stored (inline data, or fetched later by a job); the first inbound messages of an unlinked chat are searched for a
 *    hand-off code (`ChatLinker`). Realtime events fire after all of it, so the first broadcast already shows the link.
 *  - Everything after the insert is idempotent and finished by a RETRY: a delivery that stored its row but failed afterwards (the queue
 *    refused the media job, the linker was a deadlock victim) hits the existing row on its next run, and because the row is not marked
 *    `announced_at` yet, that run does the media, the link and the events again. A repeat of a finished message is a plain `duplicate`.
 */
final class InboundMessageRecorder
{
    /** The text stored for a message without text, so the inbox row is never blank. */
    private const PREVIEW_LABELS = [
        'image' => 'Photo', 'video' => 'Video', 'audio' => 'Audio', 'voice' => 'Voice message', 'document' => 'Document',
        'sticker' => 'Sticker', 'location' => 'Location', 'contact' => 'Contact', 'other' => 'Message',
    ];

    /** A reply that was stored but not yet matched to OpenWA's id is looked for among the pending ones of this age. */
    private const ADOPT_WINDOW_MINUTES = 30;

    /** The raw object is kept for debugging only; past this size (in JSON bytes) just its scalar fields are. */
    private const RAW_LIMIT = 65_536;

    public function __construct(
        private readonly ChatLinker $linker,
        private readonly WaMediaStore $media,
    ) {}

    /**
     * @param  array<array-key, mixed>  $data
     */
    public function record(WhatsAppSession $session, array $data, string $event): WebhookResult
    {
        $fromMe = $event === 'message.sent' || Payload::bool($data, 'fromMe');
        $chatId = ChatId::normalise($data['chatId'] ?? ($fromMe ? ($data['to'] ?? null) : ($data['from'] ?? null)));

        if ($chatId === null) {
            return WebhookResult::ignored('The message names no chat.');
        }

        $kind = ChatId::kind($chatId, Payload::string($data, 'kind', 20));

        if ($kind === ChatId::OTHER || ($kind === ChatId::GROUP && settings()->bool('whatsapp.ignore_groups', true))) {
            return WebhookResult::ignored($kind === ChatId::GROUP ? 'Groups are ignored.' : 'Not a chat of a person.');
        }

        $waMessageId = Payload::string($data, 'id', 129);

        if ($waMessageId === null || strlen($waMessageId) > 128) {
            return WebhookResult::ignored('The message has no usable id.');
        }

        $type = WaMessageType::fromOpenWa(Payload::string($data, 'type', 32));
        $body = $this->body($data['body'] ?? null);
        $moment = $this->moment($data['timestamp'] ?? null);
        $contact = Payload::array($data, 'contact');
        $pushName = $fromMe ? null : MessageText::singleLine(Payload::string($contact, 'pushName', 200) ?? Payload::string($contact, 'name', 200), 120);
        $phone = PhoneNumber::fromChatId($chatId)
            ?? ($fromMe ? null : PhoneNumber::e164(Payload::string($data, 'senderPhone', 32) ?? Payload::string($contact, 'number', 32)));

        $chat = $this->chat($session, $chatId, $kind === ChatId::GROUP, $phone, $pushName, ! $fromMe);

        if ($fromMe && ($adopted = $this->adoptPendingReply($chat, $waMessageId, $body)) !== null) {
            WaMessageStatusChanged::dispatch($adopted, WaMessageStatus::Pending);

            return WebhookResult::processed();
        }

        $inline = $this->inlineMedia($data, $type);
        $row = $this->row($chat, $fromMe, $waMessageId, $type, $body, $moment, $data, $inline);

        $stored = DeadlockRetry::transaction(function () use ($chat, $row, $fromMe, $moment, $body, $type, $phone, $pushName): bool {
            if (WaMessage::query()->insertOrIgnore([$row]) === 0) {
                return false;
            }

            $this->touchChat($chat, $fromMe, $moment, $body, $type, $phone, $pushName);

            return true;
        });

        $message = WaMessage::query()->where('wa_chat_id', $chat->id)->where('wa_message_id', $waMessageId)->first();

        if ($message === null) {
            // `INSERT IGNORE` also swallows genuine errors: a row that is neither stored nor a duplicate is a failure (the job retries).
            throw new \RuntimeException('The message could not be stored.');
        }

        // The same message again, and everything was done the first time: nothing to do. (A stored row that was NOT finished falls through.)
        if (! $stored && $message->announced_at !== null) {
            return WebhookResult::duplicate();
        }

        $this->storeMedia($message, $type, $inline, $data);

        if (! $fromMe) {
            $this->linker->attempt($chat->refresh(), $message);
            WaMessageReceived::dispatch($message->load('chat'));
        } else {
            WaMessageSent::dispatch($message->load('chat'));
        }

        WaMessage::query()->whereKey($message->id)->whereNull('announced_at')->update(['announced_at' => now()]);

        return WebhookResult::processed();
    }

    /**
     * The chat of this customer in this session (created on first contact). Creating races: whoever loses the unique index reads the
     * winner's row. Not inside a transaction on purpose: the read after a lost race must see the committed row.
     */
    private function chat(WhatsAppSession $session, string $chatId, bool $group, ?string $phone, ?string $pushName, bool $inbound): WaChat
    {
        $find = fn (): ?WaChat => WaChat::query()->where('session_id', $session->id)->where('chat_id', $chatId)->first();

        if (($chat = $find()) !== null) {
            return $chat;
        }

        try {
            return WaChat::query()->create([
                'workspace_id' => $session->workspace_id,
                'session_id' => $session->id,
                'chat_id' => $chatId,
                'phone_e164' => $phone,
                'push_name' => $pushName,
                'is_group' => $group,
                'inbound_initiated' => $inbound,
            ]);
        } catch (UniqueConstraintViolationException) {
            return WaChat::query()->where('session_id', $session->id)->where('chat_id', $chatId)->lockForUpdate()->firstOrFail();
        }
    }

    /**
     * The echo of a reply this application stored (`message.sent` arriving before the send job could store OpenWA's id): the pending
     * row with the same text takes the id, so the reply is one message, not two.
     */
    private function adoptPendingReply(WaChat $chat, string $waMessageId, ?string $body): ?WaMessage
    {
        if ($body === null) {
            return null;
        }

        $pending = WaMessage::query()
            ->where('wa_chat_id', $chat->id)
            ->where('direction', WaDirection::Out->value)
            ->where('status', WaMessageStatus::Pending->value)
            ->whereNull('wa_message_id')
            ->where('body', $body)
            ->where('created_at', '>=', now()->subMinutes(self::ADOPT_WINDOW_MINUTES))
            ->orderBy('id')
            ->first();

        if ($pending === null) {
            return null;
        }

        $adopted = WaMessage::query()
            ->whereKey($pending->id)
            ->whereNull('wa_message_id')
            ->where('status', WaMessageStatus::Pending->value)
            ->update(['wa_message_id' => $waMessageId, 'status' => WaMessageStatus::Sent->value, 'updated_at' => now()]);

        return $adopted === 1 ? $pending->refresh() : null;
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @param  array{bytes: string|null, mime: string|null, filename: string|null, size: int|null}|null  $inline
     * @return array<string, mixed>
     */
    private function row(WaChat $chat, bool $fromMe, string $waMessageId, WaMessageType $type, ?string $body, CarbonImmutable $moment, array $data, ?array $inline): array
    {
        $now = now()->toDateTimeString();

        return [
            'ulid' => strtolower((string) Str::ulid()),
            'wa_chat_id' => $chat->id,
            'direction' => ($fromMe ? WaDirection::Out : WaDirection::In)->value,
            'wa_message_id' => $waMessageId,
            'type' => $type->value,
            'body' => $body,
            'media_mime' => $inline['mime'] ?? null,
            'media_filename' => $inline['filename'] ?? null,
            'media_size' => $inline['size'] ?? null,
            'status' => ($fromMe ? WaMessageStatus::Sent : WaMessageStatus::Received)->value,
            'wa_timestamp' => $moment->setTimezone((string) config('app.timezone', 'UTC'))->format('Y-m-d H:i:s'),
            'raw' => $this->raw($data),
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    /**
     * The chat's counters and "last message" columns, in the transaction of the row: an unread message and a re-opened chat for an
     * inbound one, the preview and times only moving forward.
     */
    private function touchChat(WaChat $chat, bool $fromMe, CarbonImmutable $moment, ?string $body, WaMessageType $type, ?string $phone, ?string $pushName): void
    {
        $at = $moment->setTimezone((string) config('app.timezone', 'UTC'))->format('Y-m-d H:i:s');

        if (! $fromMe) {
            WaChat::query()->whereKey($chat->id)->update([
                'unread_by_admin' => DB::raw('unread_by_admin + 1'),
                'status' => 'open',
                'updated_at' => now(),
            ]);
            WaChat::query()->whereKey($chat->id)->where(fn ($query) => $query->whereNull('last_inbound_at')->orWhere('last_inbound_at', '<', $at))->update(['last_inbound_at' => $at]);
        }

        WaChat::query()->whereKey($chat->id)->where(fn ($query) => $query->whereNull('last_message_at')->orWhere('last_message_at', '<=', $at))->update([
            'last_message_at' => $at,
            'last_message_preview' => $this->preview($body, $type),
        ]);

        if ($pushName !== null) {
            WaChat::query()->whereKey($chat->id)->where(fn ($query) => $query->whereNull('push_name')->orWhere('push_name', '!=', $pushName))->update(['push_name' => $pushName]);
        }

        if ($phone !== null && $chat->phone_e164 === null) {
            WaChat::query()->whereKey($chat->id)->whereNull('phone_e164')->update(['phone_e164' => $phone]);
        }
    }

    private function preview(?string $body, WaMessageType $type): string
    {
        return MessageText::preview($body, 160) ?? __(self::PREVIEW_LABELS[$type->value] ?? 'Message');
    }

    private function body(mixed $value): ?string
    {
        if (! is_string($value)) {
            return null;
        }

        $text = MessageText::clean($value);

        return $text === null ? null : mb_substr($text, 0, MessageText::HARD_MAX_LENGTH);
    }

    /** The message's own time (epoch seconds), kept inside a sane window: a clock that is off must not pin a chat to the year 2100. */
    private function moment(mixed $value): CarbonImmutable
    {
        $moment = Payload::moment($value);

        if ($moment === null || $moment->isBefore('2009-01-01') || $moment->isAfter(now()->addDay())) {
            return CarbonImmutable::now();
        }

        return $moment;
    }

    /**
     * What the message says about its file: type, name and size always, the bytes when OpenWA inlined them.
     *
     * @param  array<array-key, mixed>  $data
     * @return array{bytes: string|null, mime: string|null, filename: string|null, size: int|null}|null
     */
    private function inlineMedia(array $data, WaMessageType $type): ?array
    {
        $media = Payload::array($data, 'media');

        if ($media === [] && ! $type->isMedia()) {
            return null;
        }

        $encoded = is_string($media['data'] ?? null) && $media['data'] !== '' ? $media['data'] : null;
        $bytes = $type->isStoredAsFile() && $encoded !== null ? $this->media->inlineBytes($encoded) : null;
        $size = isset($media['sizeBytes']) && is_numeric($media['sizeBytes']) ? max(0, (int) $media['sizeBytes']) : ($encoded !== null ? (int) (strlen($encoded) * 3 / 4) : null);

        return [
            'bytes' => $bytes,
            'mime' => Payload::string($media, 'mimetype', 100),
            'filename' => $this->fileName(Payload::string($media, 'filename', 255)),
            'size' => $size,
        ];
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @param  array{bytes: string|null, mime: string|null, filename: string|null, size: int|null}|null  $inline
     */
    private function storeMedia(WaMessage $message, WaMessageType $type, ?array $inline, array $data): void
    {
        // Not an image, or its file is already there (a retried delivery): nothing to store or fetch.
        if (! $type->isStoredAsFile() || $inline === null || $message->hasStoredMedia()) {
            return;
        }

        if ($inline['bytes'] !== null) {
            if ($this->media->store($message, $inline['bytes'], $inline['filename'])) {
                $message->refresh();
            }

            return;
        }

        $this->media->queueFetch($message);
    }

    /**
     * The message object as OpenWA sent it, as JSON: without the inline file (an image is stored on its own) and, when it is still large,
     * reduced to its scalar fields.
     *
     * @param  array<array-key, mixed>  $data
     */
    private function raw(array $data): string
    {
        if (isset($data['media']) && is_array($data['media']) && array_key_exists('data', $data['media'])) {
            $data['media']['data'] = '[omitted]';
        }

        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);

        if ($json === false || strlen($json) > self::RAW_LIMIT) {
            $json = json_encode(array_filter($data, is_scalar(...)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }

        return $json === false ? '{}' : (string) $json;
    }

    private function fileName(?string $name): ?string
    {
        if ($name === null) {
            return null;
        }

        $name = trim(mb_substr((string) preg_replace('/[^\p{L}\p{N}._ \-()]/u', '', basename(str_replace('\\', '/', $name))), 0, 120));

        return $name === '' ? null : $name;
    }
}
