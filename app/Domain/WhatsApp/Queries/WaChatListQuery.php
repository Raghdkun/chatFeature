<?php

namespace App\Domain\WhatsApp\Queries;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Models\Category;
use App\Models\WaChat;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;

/**
 * The admin inbox list and the export: the filters over `wa_chats` (administrators only: nothing here is ever scoped to an agent,
 * because an agent never reaches it). `status` open (default) / archived / all, `session` (ulid, a deleted session's chats included),
 * `linked`, `widget` (ulid), `category` (ulid or slug), `unread`, `q` = {@see WaChat::search()}. Newest activity first through
 * {@see WaChatCursor}.
 */
final class WaChatListQuery
{
    /** The sort key of the inbox: the last message, else the creation of the chat. */
    public const SORT = 'COALESCE(wa_chats.last_message_at, wa_chats.created_at)';

    /**
     * @param  array<string, mixed>  $filters  status, session, linked, widget, category, unread, q
     * @return Builder<WaChat>
     */
    public function build(array $filters): Builder
    {
        $query = WaChat::query();
        $status = is_string($filters['status'] ?? null) ? $filters['status'] : WaChatStatus::Open->value;

        if ($status !== 'all') {
            $query->where('wa_chats.status', $status === WaChatStatus::Archived->value ? WaChatStatus::Archived->value : WaChatStatus::Open->value);
        }

        if (filled($filters['session'] ?? null)) {
            $query->whereIn('wa_chats.session_id', WhatsAppSession::withTrashed()->where('ulid', (string) $filters['session'])->select('id'));
        }

        if (isset($filters['linked']) && $filters['linked'] !== '') {
            filter_var($filters['linked'], FILTER_VALIDATE_BOOLEAN)
                ? $query->whereNotNull('wa_chats.widget_id')
                : $query->whereNull('wa_chats.widget_id');
        }

        if (filled($filters['widget'] ?? null)) {
            $query->whereIn('wa_chats.widget_id', Widget::withTrashed()->where('ulid', (string) $filters['widget'])->select('id'));
        }

        if (filled($filters['category'] ?? null)) {
            $category = (string) $filters['category'];
            $query->whereIn('wa_chats.category_id', Category::withTrashed()->where(fn ($match) => $match->where('ulid', $category)->orWhere('slug', $category))->select('id'));
        }

        if (filter_var($filters['unread'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
            $query->where('wa_chats.unread_by_admin', '>', 0);
        }

        if (filled($filters['q'] ?? null)) {
            $query->search((string) $filters['q']);
        }

        return $query;
    }

    /**
     * The inbox order, continuing after `$cursor` when there is one.
     *
     * @param  Builder<WaChat>  $query
     * @return Builder<WaChat>
     */
    public function ordered(Builder $query, ?WaChatCursor $cursor = null): Builder
    {
        if ($cursor !== null) {
            $query->where(fn ($page) => $page
                ->whereRaw(self::SORT.' < ?', [$cursor->time])
                ->orWhere(fn ($tie) => $tie->whereRaw(self::SORT.' = ?', [$cursor->time])->where('wa_chats.id', '<', $cursor->id)));
        }

        return $query->orderByRaw(self::SORT.' desc')->orderByDesc('wa_chats.id');
    }

    /** Open chats with something unread, whatever the filters: the number on the sidebar entry. */
    public function unreadChats(): int
    {
        return WaChat::query()->where('status', WaChatStatus::Open->value)->where('unread_by_admin', '>', 0)->count();
    }

    /** A filter time as the instant the database compares against (a bare date ends at the end of that day). */
    public static function instant(string $value, bool $endOfBareDate = false): Carbon
    {
        $time = Carbon::parse($value);

        if ($endOfBareDate && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $value) === 1) {
            $time = $time->endOfDay();
        }

        return $time->setTimezone((string) config('app.timezone', 'UTC'));
    }
}
