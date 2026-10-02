<?php

namespace App\Domain\WhatsApp\Support;

use App\Domain\Chat\Queries\ConversationSearch;
use App\Models\WaChat;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Facades\DB;

/**
 * The one text search over WhatsApp chats (`WaChat::search()`), built like `ConversationSearch`. A chat matches when the text is part of
 *
 * - its number, name or last message (`LIKE`; a typed number also matches without spaces, dashes or the plus sign),
 * - the name, e-mail address or phone number of the visitor it is linked to (`LIKE`), or
 * - the text of one of its messages: MySQL / MariaDB use the FULLTEXT index on `wa_messages.body` (boolean mode, every word a prefix,
 *   all words required), SQLite (tests) and words too short for the index fall back to `LIKE`.
 *
 * `%`, `_` and `!` in the text are literal (`LIKE ... ESCAPE '!'`; SQLite has no default escape character). Admin-only data: the callers
 * sit behind `wa.admin`.
 */
final class WaChatSearch
{
    /**
     * @param  Builder<WaChat>  $query
     */
    public function apply(Builder $query, string $text): void
    {
        $text = trim($text);

        if ($text === '') {
            return;
        }

        $like = self::like($text);
        $digits = preg_replace('/\D+/', '', $text) ?? '';
        $numberLike = strlen($digits) >= 3 ? self::like($digits) : null;

        $query->where(function (Builder $match) use ($text, $like, $numberLike): void {
            $match->whereRaw("wa_chats.phone_e164 like ? escape '!'", [$like])
                ->orWhereRaw("wa_chats.push_name like ? escape '!'", [$like])
                ->orWhereRaw("wa_chats.last_message_preview like ? escape '!'", [$like]);

            if ($numberLike !== null) {
                $match->orWhereRaw("wa_chats.phone_e164 like ? escape '!'", [$numberLike]);
            }

            $match->orWhereExists(function (QueryBuilder $visitors) use ($like): void {
                $visitors->selectRaw('1')->from('visitors')->whereColumn('visitors.id', 'wa_chats.visitor_id')
                    ->where(function (QueryBuilder $contact) use ($like): void {
                        foreach (['name', 'email', 'phone'] as $column) {
                            $contact->orWhereRaw("visitors.{$column} like ? escape '!'", [$like]);
                        }
                    });
            })->orWhereExists(function (QueryBuilder $messages) use ($text, $like): void {
                $messages->selectRaw('1')->from('wa_messages')->whereColumn('wa_messages.wa_chat_id', 'wa_chats.id');

                $expression = in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true) ? ConversationSearch::booleanExpression($text) : null;

                if ($expression !== null) {
                    $messages->whereRaw('MATCH(wa_messages.body) AGAINST (? IN BOOLEAN MODE)', [$expression]);
                } else {
                    $messages->whereRaw("wa_messages.body like ? escape '!'", [$like]);
                }
            });
        });
    }

    private static function like(string $text): string
    {
        return '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $text).'%';
    }
}
