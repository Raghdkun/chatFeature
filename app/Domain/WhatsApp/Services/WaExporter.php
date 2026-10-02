<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\WaChat;
use App\Models\WaMessage;
use Closure;
use Illuminate\Database\Eloquent\Builder;

/**
 * Streams the WhatsApp inbox out of the database for the admin export (`GET /whatsapp/export`): rows are read in chunks of 500 by primary key
 * (`lazyById`) and written straight to the output, so memory stays flat however large the range is. `messages` is one row per message
 * (the transcript of every chat in the filter), `chats` one row per chat. CSV cells a spreadsheet would treat as a formula (starting with
 * `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with a quote, exactly like the live chat's export. Queries must already be filtered.
 * Never part of a row: the WhatsApp message id, the raw webhook object, the storage path of a file.
 */
final class WaExporter
{
    public const CHUNK = 500;

    public const MESSAGE_COLUMNS = [
        'message', 'chat', 'session', 'phone', 'push_name', 'widget', 'category', 'direction', 'type', 'status', 'sent_by', 'timestamp',
        'body', 'media_filename', 'media_mime', 'media_size',
    ];

    public const CHAT_COLUMNS = [
        'chat', 'session', 'phone', 'push_name', 'is_group', 'status', 'linked', 'widget', 'category', 'visitor_name', 'visitor_email',
        'unread', 'inbound_initiated', 'messages', 'last_message_at', 'created_at',
    ];

    /**
     * @param  Builder<WaMessage>|Builder<WaChat>  $query
     * @return Closure(): void
     */
    public function csv(Builder $query, bool $messages): Closure
    {
        return function () use ($query, $messages): void {
            $out = fopen('php://output', 'wb');

            if ($out === false) {
                return;
            }

            fputcsv($out, $messages ? self::MESSAGE_COLUMNS : self::CHAT_COLUMNS, ',', '"', '');

            foreach ($this->rows($query, $messages) as $row) {
                fputcsv($out, array_map($this->cell(...), array_values($row)), ',', '"', '');
            }

            fclose($out);
        };
    }

    /**
     * @param  Builder<WaMessage>|Builder<WaChat>  $query
     * @return Closure(): void
     */
    public function json(Builder $query, bool $messages): Closure
    {
        return function () use ($query, $messages): void {
            echo '{"data":[';

            $first = true;

            foreach ($this->rows($query, $messages) as $row) {
                echo ($first ? '' : ',').json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                $first = false;
            }

            echo ']}';
        };
    }

    /**
     * @param  Builder<WaMessage>|Builder<WaChat>  $query
     * @return iterable<array<string, scalar|null>>
     */
    private function rows(Builder $query, bool $messages): iterable
    {
        // A large range outlives PHP's `max_execution_time`: the limit is lifted for this one stream (the stream ends with the client).
        if (function_exists('set_time_limit')) {
            @set_time_limit(0);
        }

        if ($messages) {
            /** @var Builder<WaMessage> $query */
            $export = $query->with(['chat.session', 'chat.widget', 'chat.category', 'sentBy']);

            foreach ($export->lazyById(self::CHUNK, 'wa_messages.id', 'id') as $message) {
                yield $this->messageRow($message);
            }

            return;
        }

        /** @var Builder<WaChat> $query */
        $export = $query->with(['session', 'widget', 'category', 'visitor'])->withCount('messages');

        foreach ($export->lazyById(self::CHUNK, 'wa_chats.id', 'id') as $chat) {
            yield $this->chatRow($chat);
        }
    }

    /**
     * @return array<string, scalar|null>
     */
    private function messageRow(WaMessage $message): array
    {
        $chat = $message->chat;

        return [
            'message' => $message->ulid,
            'chat' => $chat->ulid,
            'session' => $chat->session->name,
            'phone' => $chat->phone_e164,
            'push_name' => $chat->push_name,
            'widget' => $chat->widget?->name,
            'category' => $chat->category?->name,
            'direction' => $message->direction->value,
            'type' => $message->type->value,
            'status' => $message->status->value,
            'sent_by' => $message->sentBy?->label,
            'timestamp' => Timestamps::iso($message->wa_timestamp),
            'body' => $message->body,
            'media_filename' => $message->media_filename,
            'media_mime' => $message->media_mime,
            'media_size' => $message->media_size,
        ];
    }

    /**
     * @return array<string, scalar|null>
     */
    private function chatRow(WaChat $chat): array
    {
        return [
            'chat' => $chat->ulid,
            'session' => $chat->session->name,
            'phone' => $chat->phone_e164,
            'push_name' => $chat->push_name,
            'is_group' => $chat->is_group,
            'status' => $chat->status->value,
            'linked' => $chat->isLinked(),
            'widget' => $chat->widget?->name,
            'category' => $chat->category?->name,
            'visitor_name' => $chat->visitor?->name,
            'visitor_email' => $chat->visitor?->email,
            'unread' => $chat->unread_by_admin,
            'inbound_initiated' => $chat->inbound_initiated,
            'messages' => (int) $chat->getAttribute('messages_count'),
            'last_message_at' => Timestamps::iso($chat->last_message_at),
            'created_at' => Timestamps::iso($chat->created_at),
        ];
    }

    private function cell(mixed $value): mixed
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        if (is_string($value) && $value !== '' && in_array($value[0], ['=', '+', '-', '@', "\t", "\r"], true)) {
            return "'".$value;
        }

        return $value;
    }
}
