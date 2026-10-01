<?php

namespace App\Http\Controllers\Dashboard;

use App\Data\Chat\RatingData;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Queries\ConversationSearch;
use App\Http\Controllers\Controller;
use App\Http\Controllers\Dashboard\Concerns\PresentsConversations;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Rating;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Carbon\Exceptions\InvalidFormatException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Pagination\LengthAwarePaginator;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `history/index` (admin only): every conversation, newest first, filtered and paged through the query string
 * (`status, category, widget, agent, type, q, from, to, page`) so the page works with Inertia partial reloads and the filtered view
 * can be linked or exported. Unknown or malformed filter values are ignored rather than rejected (a stale link must still open).
 */
class HistoryPageController extends Controller
{
    use PresentsConversations;

    public const PER_PAGE = 25;

    public function index(Request $request): Response
    {
        $filters = $this->filters($request);
        $page = $this->query($filters)->paginate(self::PER_PAGE)->withQueryString();

        return Inertia::render('history/index', [
            'conversations' => $this->staffRows($page->getCollection()),
            'pagination' => $this->pagination($page),
            'filters' => $filters,
            'ratings' => $this->ratings($page->getCollection()->modelKeys()),
            // Constant for the session: a partial reload that does not ask for it never builds it.
            'filterOptions' => fn (): array => $this->filterOptions(),
        ]);
    }

    /**
     * The normalised filters (`''` = not set); this is also what the page echoes back to fill its controls.
     *
     * @return array<string, string>
     */
    private function filters(Request $request): array
    {
        $status = ConversationStatus::tryFrom((string) $request->query('status'));
        $type = ConversationType::tryFrom((string) $request->query('type'));
        $agent = $request->query('agent');

        return [
            'status' => $status->value ?? '',
            'type' => $type->value ?? '',
            'category' => $this->ulid($request->query('category')),
            'widget' => $this->ulid($request->query('widget')),
            'agent' => is_string($agent) && ctype_digit($agent) ? $agent : '',
            'from' => $this->date($request->query('from'))?->format('Y-m-d') ?? '',
            'to' => $this->date($request->query('to'))?->format('Y-m-d') ?? '',
            'q' => mb_substr(trim((string) $request->query('q')), 0, 100),
        ];
    }

    private function ulid(mixed $value): string
    {
        return is_string($value) && preg_match('/^[0-9A-Za-z]{26}$/', $value) === 1 ? $value : '';
    }

    private function date(mixed $value): ?CarbonImmutable
    {
        if (! is_string($value) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) !== 1) {
            return null;
        }

        try {
            $date = CarbonImmutable::createFromFormat('!Y-m-d', $value);
        } catch (InvalidFormatException) {
            return null;
        }

        // `2026-02-31` parses (it rolls over); only a date that survives the round trip is a real one.
        return $date->format('Y-m-d') === $value ? $date : null;
    }

    /**
     * @param  array<string, string>  $filters
     * @return Builder<Conversation>
     */
    private function query(array $filters): Builder
    {
        $query = $this->withStaffRelations(Conversation::query())->orderByDesc('created_at')->orderByDesc('id');

        if ($filters['status'] !== '') {
            $query->where('status', $filters['status']);
        }

        if ($filters['type'] !== '') {
            $query->where('type', $filters['type']);
        }

        if ($filters['category'] !== '') {
            $query->whereHas('category', fn (Builder $category) => $category->where('ulid', $filters['category']));
        }

        if ($filters['widget'] !== '') {
            $query->whereHas('widget', fn (Builder $widget) => $widget->where('ulid', $filters['widget']));
        }

        if ($filters['agent'] !== '') {
            $query->where('assigned_agent_id', (int) $filters['agent']);
        }

        if ($filters['from'] !== '') {
            $query->where('created_at', '>=', $this->date($filters['from'])?->startOfDay());
        }

        if ($filters['to'] !== '') {
            $query->where('created_at', '<=', $this->date($filters['to'])?->endOfDay());
        }

        if ($filters['q'] !== '') {
            app(ConversationSearch::class)->apply($query, $filters['q']);
        }

        return $query;
    }

    /**
     * @param  LengthAwarePaginator<int, Conversation>  $page
     * @return array{page: int, perPage: int, total: int, lastPage: int, from: int|null, to: int|null}
     */
    private function pagination(LengthAwarePaginator $page): array
    {
        return [
            'page' => $page->currentPage(),
            'perPage' => $page->perPage(),
            'total' => $page->total(),
            'lastPage' => $page->lastPage(),
            'from' => $page->firstItem(),
            'to' => $page->lastItem(),
        ];
    }

    /**
     * Ratings of the conversations on this page (admins only see them: this page is admin only).
     *
     * @param  array<int, int|string>  $conversationIds
     * @return array<int, array<string, mixed>>
     */
    private function ratings(array $conversationIds): array
    {
        return Rating::query()
            ->with('conversation:id,ulid')
            ->whereIn('conversation_id', $conversationIds)
            ->get()
            ->map(fn (Rating $rating): array => RatingData::fromModel($rating)->toArray())
            ->values()
            ->all();
    }

    /**
     * What the filter dropdowns offer (soft-deleted categories and widgets stay: old conversations still point at them).
     *
     * @return array{categories: array<int, array{ulid: string, name: string}>, widgets: array<int, array{ulid: string, name: string}>, agents: array<int, array{id: int, name: string}>}
     */
    private function filterOptions(): array
    {
        return [
            'categories' => Category::withTrashed()->orderBy('name')->get(['ulid', 'name'])
                ->map(fn (Category $category): array => ['ulid' => $category->ulid, 'name' => $category->name])->values()->all(),
            'widgets' => Widget::withTrashed()->orderBy('name')->get(['ulid', 'name'])
                ->map(fn (Widget $widget): array => ['ulid' => $widget->ulid, 'name' => $widget->name])->values()->all(),
            'agents' => User::query()->where('is_agent', true)->orderBy('name')->get(['id', 'name'])
                ->map(fn (User $user): array => ['id' => $user->id, 'name' => $user->name])->values()->all(),
        ];
    }
}
