<?php

namespace App\Domain\Chat\Queries;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;

/**
 * The staff conversation list: always starts from `Conversation::visibleTo($user)` (an agent sees what is assigned to them, what
 * is offered to them while queued and the offline tickets of their categories; an admin sees everything; WhatsApp chats are not
 * conversations and never appear), then narrows it with the caller's filters. Shared by `GET /conversations` and the export.
 *
 * `q` is `ConversationSearch`, the same search the admin history page runs: ticket number, the visitor's name / e-mail / phone, or
 * the text of a message.
 */
final class ConversationListQuery
{
    public function __construct(private readonly ConversationSearch $search = new ConversationSearch) {}

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
            $query->where('conversations.created_at', '>=', $this->instant((string) $filters['from']));
        }

        if (filled($filters['to'] ?? null)) {
            $to = (string) $filters['to'];

            // A bare date ends at the end of that day, so `to=2026-01-31` includes the 31st.
            $query->where('conversations.created_at', '<=', $this->instant($to, endOfBareDate: true));
        }

        if (filled($filters['updated_after'] ?? null)) {
            // Inclusive: times have second precision, so a change in the very second of the client's last sync must not be missed
            // (clients merge by ulid, a repeated row is harmless).
            $query->where('conversations.updated_at', '>=', $this->instant((string) $filters['updated_after']));
        }

        if (filled($filters['q'] ?? null)) {
            $this->search->apply($query, (string) $filters['q']);
        }

        return $query;
    }

    /**
     * A filter time as the instant the database compares against. Timestamps are stored in the application timezone without an
     * offset, so a value written with one (`...+03:00`) is converted first: binding the Carbon as it is would drop the offset and
     * compare the wall-clock digits of another timezone.
     */
    private function instant(string $value, bool $endOfBareDate = false): Carbon
    {
        $time = Carbon::parse($value);

        if ($endOfBareDate && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $value) === 1) {
            $time = $time->endOfDay();
        }

        return $time->setTimezone((string) config('app.timezone', 'UTC'));
    }
}
