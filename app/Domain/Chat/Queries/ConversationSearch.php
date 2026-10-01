<?php

namespace App\Domain\Chat\Queries;

use App\Models\Conversation;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Facades\DB;

/**
 * The one text search over conversations, shared by the REST list / export (`ConversationListQuery`) and the admin history page, so
 * a search finds the same conversations in both. A conversation matches when the text is part of
 *
 * - its ticket number (`LIKE`),
 * - the visitor's name, e-mail address or phone number (`LIKE`), or
 * - the text of one of its messages: MySQL / MariaDB use the FULLTEXT index on `messages.body` (boolean mode, every word a prefix,
 *   all words required), SQLite (tests) and words too short for the index fall back to `LIKE`.
 *
 * `%`, `_` and `!` in the text are literal (`LIKE ... ESCAPE '!'`; SQLite has no default escape character).
 */
final class ConversationSearch
{
    /** InnoDB indexes words of at least this many characters (`innodb_ft_min_token_size`). */
    private const FULLTEXT_MIN_WORD = 3;

    private const FULLTEXT_MAX_WORDS = 8;

    /**
     * @param  Builder<Conversation>  $query
     */
    public function apply(Builder $query, string $text): void
    {
        $text = trim($text);

        if ($text === '') {
            return;
        }

        $like = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $text).'%';

        $query->where(function (Builder $match) use ($text, $like): void {
            $match->whereRaw("conversations.ticket_no like ? escape '!'", [$like])
                ->orWhereExists(function (QueryBuilder $visitors) use ($like): void {
                    $visitors->selectRaw('1')->from('visitors')->whereColumn('visitors.id', 'conversations.visitor_id')
                        ->where(function (QueryBuilder $contact) use ($like): void {
                            foreach (['name', 'email', 'phone'] as $column) {
                                $contact->orWhereRaw("visitors.{$column} like ? escape '!'", [$like]);
                            }
                        });
                })
                ->orWhereExists(function (QueryBuilder $messages) use ($text, $like): void {
                    $messages->selectRaw('1')->from('messages')->whereColumn('messages.conversation_id', 'conversations.id');

                    $expression = in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true) ? self::booleanExpression($text) : null;

                    if ($expression !== null) {
                        $messages->whereRaw('MATCH(messages.body) AGAINST (? IN BOOLEAN MODE)', [$expression]);
                    } else {
                        $messages->whereRaw("messages.body like ? escape '!'", [$like]);
                    }
                });
        });
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
}
