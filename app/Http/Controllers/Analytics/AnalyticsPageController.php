<?php

namespace App\Http\Controllers\Analytics;

use App\Data\Analytics\AnalyticsFiltersData;
use App\Data\Analytics\AnalyticsOptionData;
use App\Data\Analytics\AnalyticsOptionsData;
use App\Data\Analytics\AnalyticsPageData;
use App\Data\Analytics\AnalyticsPageScopeData;
use App\Domain\Analytics\AnalyticsScope;
use App\Domain\Analytics\Support\AnalyticsTimezone;
use App\Http\Controllers\Controller;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Inertia page `analytics/index` for every staff member: the full dashboard for an administrator, "My performance" for an agent. The page
 * is only a shell (who is looking, the time zone, the filters of the URL, the filter menus): the numbers come from the analytics API after
 * the first paint, so the same code answers the page and any other client. Like the history page it never rejects a stale link: an
 * unknown or malformed value in the query string is dropped, and an agent's filters are always their own.
 */
class AnalyticsPageController extends Controller
{
    public function index(Request $request): Response
    {
        $user = $request->user();

        abort_unless($user instanceof User, 401);

        $role = AnalyticsScope::roleOf($user);

        abort_if($role === null, 403);

        $timezone = AnalyticsTimezone::current();
        $today = AnalyticsTimezone::today($timezone);
        $admin = $role === 'admin';

        $to = min($this->date($request->query('to')) ?? $today, $today);
        $from = $this->date($request->query('from')) ?? CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')->subDays(29)->format('Y-m-d');

        if ($from > $to || CarbonImmutable::createFromFormat('!Y-m-d', $from, 'UTC')->diffInDays(CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')) + 1 > (int) config('analytics.max_range_days', 731)) {
            $from = CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')->subDays(29)->format('Y-m-d');
        }

        $widget = $admin ? $this->ulid($request->query('widget')) : null;
        $category = $admin && $widget === null ? $this->ulid($request->query('category')) : null;
        $agent = $admin && $widget === null && $category === null ? $this->id($request->query('agent')) : null;

        return Inertia::render('analytics/index', (new AnalyticsPageData(
            scope: new AnalyticsPageScopeData($role, $user->id, $admin),
            timezone: $timezone,
            today: $today,
            filters: new AnalyticsFiltersData($from, $to, $widget, $category, $agent, $request->query('compare') !== '0'),
            options: $admin ? $this->options() : new AnalyticsOptionsData([], [], []),
        ))->toArray());
    }

    private function options(): AnalyticsOptionsData
    {
        return new AnalyticsOptionsData(
            widgets: array_values(Widget::withTrashed()->orderBy('name')->get(['ulid', 'name', 'deleted_at'])
                ->map(fn (Widget $widget): AnalyticsOptionData => new AnalyticsOptionData($widget->ulid, $widget->name, $widget->deleted_at !== null))->all()),
            categories: array_values(Category::withTrashed()->orderBy('name')->get(['ulid', 'name', 'deleted_at'])
                ->map(fn (Category $category): AnalyticsOptionData => new AnalyticsOptionData($category->ulid, $category->name, $category->deleted_at !== null))->all()),
            agents: array_values(User::query()->where('is_agent', true)->orderBy('name')->get()
                ->map(fn (User $user): AnalyticsOptionData => new AnalyticsOptionData((string) $user->id, $user->label, ! $user->is_active))->all()),
        );
    }

    private function date(mixed $value): ?string
    {
        if (! is_string($value) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) !== 1) {
            return null;
        }

        $date = CarbonImmutable::createFromFormat('!Y-m-d', $value, 'UTC');

        // `2026-02-31` parses (it rolls over); only a date that survives the round trip is a real one.
        return $date !== null && $date->format('Y-m-d') === $value ? $value : null;
    }

    private function ulid(mixed $value): ?string
    {
        return is_string($value) && preg_match('/^[0-9A-Za-z]{26}$/', $value) === 1 ? $value : null;
    }

    private function id(mixed $value): ?int
    {
        return is_string($value) && ctype_digit($value) && (int) $value > 0 ? (int) $value : null;
    }
}
