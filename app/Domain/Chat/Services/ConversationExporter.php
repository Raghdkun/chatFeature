<?php

namespace App\Domain\Chat\Services;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\Conversation;
use Closure;
use Illuminate\Database\Eloquent\Builder;

/**
 * Streams conversations out of the database for the admin export (`GET /conversations/export`): rows are read in chunks of
 * 500 by primary key (`lazyById`) and written straight to the output, so memory stays flat however large the range is.
 * CSV cells that a spreadsheet would treat as a formula (starting with `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with a
 * quote. The query must already be restricted to what the caller may see.
 */
final class ConversationExporter
{
    public const CHUNK = 500;

    public const COLUMNS = [
        'ticket_no', 'conversation', 'type', 'status', 'widget', 'category', 'agent', 'visitor_name', 'visitor_email',
        'visitor_verified', 'created_at', 'claimed_at', 'ended_at', 'closed_at', 'ended_by', 'close_reason', 'messages', 'rating',
    ];

    /**
     * @param  Builder<Conversation>  $query
     * @return Closure(): void
     */
    public function csv(Builder $query): Closure
    {
        return function () use ($query): void {
            $out = fopen('php://output', 'wb');

            if ($out === false) {
                return;
            }

            fputcsv($out, self::COLUMNS, ',', '"', '');

            foreach ($this->rows($query) as $row) {
                fputcsv($out, array_map($this->cell(...), array_values($row)), ',', '"', '');
            }

            fclose($out);
        };
    }

    /**
     * @param  Builder<Conversation>  $query
     * @return Closure(): void
     */
    public function json(Builder $query): Closure
    {
        return function () use ($query): void {
            echo '{"data":[';

            $first = true;

            foreach ($this->rows($query) as $row) {
                echo ($first ? '' : ',').json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
                $first = false;
            }

            echo ']}';
        };
    }

    /**
     * @param  Builder<Conversation>  $query
     * @return iterable<array<string, scalar|null>>
     */
    private function rows(Builder $query): iterable
    {
        $export = $query
            ->with(['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget', 'rating'])
            ->withCount('messages');

        foreach ($export->lazyById(self::CHUNK, 'conversations.id', 'id') as $conversation) {
            yield $this->row($conversation);
        }
    }

    /**
     * @return array<string, scalar|null>
     */
    private function row(Conversation $conversation): array
    {
        return [
            'ticket_no' => $conversation->ticket_no,
            'conversation' => $conversation->ulid,
            'type' => $conversation->type->value,
            'status' => $conversation->status->value,
            'widget' => $conversation->widget->name,
            'category' => $conversation->category?->name,
            'agent' => $conversation->assignedAgent?->label,
            'visitor_name' => $conversation->visitor->name,
            'visitor_email' => $conversation->visitor->email,
            'visitor_verified' => $conversation->visitor->verified,
            'created_at' => Timestamps::iso($conversation->created_at),
            'claimed_at' => Timestamps::iso($conversation->claimed_at),
            'ended_at' => Timestamps::iso($conversation->ended_at),
            'closed_at' => Timestamps::iso($conversation->closed_at),
            'ended_by' => $conversation->ended_by?->value,
            'close_reason' => $conversation->close_reason?->value,
            'messages' => (int) $conversation->getAttribute('messages_count'),
            'rating' => $conversation->rating?->score,
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
