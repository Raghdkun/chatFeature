<?php

namespace App\Domain\Chat\Queries;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The staff conversation list: always starts from `Conversation::visibleTo($user)` (an agent sees what is assigned to them, what
 * is offered to them while queued and the offline tickets of their categories; an admin sees everything; WhatsApp chats are not
 * conversations and never appear), then narrows it with the caller's filters. Shared by `GET /conversations` and the export.
 *
 * `q` matches the ticket number exactly, or the text of a message: MySQL / MariaDB use the FULLTEXT index on `messages.body`
 * (boolean mode, every word a prefix), SQLite (tests) and words too short for the index fall back to `LIKE`.
 */
final class ConversationListQuery
{
    /** InnoDB indexes words of at least this many characters (`innodb_ft_min_token_size`). */
    private const FULLTEXT_MIN_WORD = 3;

    private const FULLTEXT_MAX_WORDS = 8;

    /**
     * @param  array<string, mixed>  $filters  status (list), category, widget, agent, type, q, from, to, updated_after
     * @return Builder<Conversation>
     */
    public function build(User $user, array $filters): Builder
    {
        $query = Conversation::query()->visibleTo($user);

        $statuses = array_values(array_filter((array) ($filters['status'] ?? []), is_string(...)));

        if ($statuses !== []) {
            $query->whereIn('conversations.status', $statuses);
        }

        if (filled($filters['type'] ?? null)) {
            $query->where('conversations.type', (string) $filters['type']);
        }

        if (filled($filters['category'] ?? null)) {
            $category = (string) $filters['category'];
            $query->whereIn('conversations.category_id', Category::withTrashed()->where(fn ($match) => $match->where('ulid', $category)->orWhere('slug', $category))->select('id'));
        }

        if (filled($filters['widget'] ?? null)) {
            $query->whereIn('conversations.widget_id', Widget::withTrashed()->where('ulid', (string) $filters['widget'])->select('id'));
        }

        if (filled($filters['agent'] ?? null)) {
            $query->where('conversations.assigned_agent_id', $filters['agent'] === 'me' ? $user->id : (int) $filters['agent']);
        }

        if (filled($filters['from'] ?? null)) {
            $query->where('conversations.created_at', '>=', Carbon::parse((string) $filters['from']));
        }

        if (filled($filters['to'] ?? null)) {
            $to = (string) $filters['to'];

            // A bare date ends at the end of that day, so `to=2026-01-31` includes the 31st.
            $query->where('conversations.created_at', '<=', preg_match('/^\d{4}-\d{2}-\d{2}$/D', $to) === 1 ? Carbon::parse($to)->endOfDay() : Carbon::parse($to));
        }

        if (filled($filters['updated_after'] ?? null)) {
            $query->where('conversations.updated_at', '>', Carbon::parse((string) $filters['updated_after']));
        }

        if (filled($filters['q'] ?? null)) {
            $this->matchText($query, trim((string) $filters['q']));
        }

        return $query;
    }

    /**
     * The boolean-mode expression for a search text (`+word*` per word), or null when no word is long enough for the index.
     */
    public static function booleanExpression(string $text): ?string
    {
        $words = preg_split('/[^\p{L}\p{N}_]+/u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $words = array_values(array_filter($words, static fn (string $word): bool => mb_strlen($word) >= self::FULLTEXT_MIN_WORD));

        if ($words === []) {
            return null;
        }

        return implode(' ', array_map(static fn (string $word): string => '+'.$word.'*', array_slice($words, 0, self::FULLTEXT_MAX_WORDS)));
    }

    /**
     * @param  Builder<Conversation>  $query
     */
    private function matchText(Builder $query, string $text): void
    {
        if ($text === '') {
            return;
        }

        $query->where(function (Builder $match) use ($text): void {
            $match->where('conversations.ticket_no', Str::upper($text))
                ->orWhereExists(function (QueryBuilder $messages) use ($text): void {
                    $messages->selectRaw('1')->from('messages')->whereColumn('messages.conversation_id', 'conversations.id');

                    $expression = in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true) ? self::booleanExpression($text) : null;

                    if ($expression !== null) {
                        $messages->whereRaw('MATCH(messages.body) AGAINST (? IN BOOLEAN MODE)', [$expression]);
                    } else {
                        $messages->whereRaw("messages.body like ? escape '!'", ['%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $text).'%']);
                    }
                });
        });
    }
}
