<?php

namespace App\Domain\Analytics;

use App\Domain\Analytics\Support\AnalyticsTimezone;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Validation\ValidationException;

/**
 * Turns the (already syntax-checked) query string into an {@see AnalyticsQuery}, and is where the rules are enforced:
 *  - the range is clamped to today at the late end, must not run backwards and is at most `analytics.max_range_days` (about two years);
 *  - an administrator may apply at most ONE filter (the rollup holds one row per widget, topic or agent, not their crossings);
 *  - an agent is always scoped to their own row: `agent=<somebody else>` is `403`, a widget or topic filter is `422` (their numbers cannot
 *    be cut that way), and no request of theirs can reach another row or the WhatsApp dimension.
 */
final class AnalyticsQueryFactory
{
    /**
     * @param  array<string, mixed>  $input  `from`, `to`, `compare`, `tz`, `widget`, `category`, `agent`
     */
    public function make(User $user, array $input): AnalyticsQuery
    {
        $role = AnalyticsScope::roleOf($user);

        if ($role === null) {
            throw ApiProblemException::forbidden('forbidden', __('This action is not allowed.'));
        }

        $timezone = AnalyticsTimezone::current();
        $today = AnalyticsTimezone::today($timezone);
        [$from, $to] = $this->range($input, $today);
        $viewer = AnalyticsTimezone::valid($this->string($input['tz'] ?? null)) ?? $timezone;

        return new AnalyticsQuery(
            $this->scope($user, $role, $input),
            $from,
            $to,
            filter_var($input['compare'] ?? false, FILTER_VALIDATE_BOOLEAN),
            $timezone,
            $viewer,
            $today,
        );
    }

    /**
     * @param  array<string, mixed>  $input
     */
    private function scope(User $user, string $role, array $input): AnalyticsScope
    {
        $widget = $this->string($input['widget'] ?? null);
        $category = $this->string($input['category'] ?? null);
        $agent = $this->string($input['agent'] ?? null);

        if ($role === 'agent') {
            if ($agent !== null && (int) $agent !== $user->id) {
                throw ApiProblemException::forbidden('forbidden', __('You can only see your own numbers.'));
            }

            if ($widget !== null || $category !== null) {
                throw ValidationException::withMessages(['widget' => [__('Your numbers cannot be filtered by widget or topic.')]]);
            }

            return new AnalyticsScope('agent', $user->id, AnalyticsColumns::AGENT, (string) $user->id, (string) $user->id);
        }

        if (count(array_filter([$widget, $category, $agent], static fn (?string $value): bool => $value !== null)) > 1) {
            throw ValidationException::withMessages(['filter' => [__('Filter by one of widget, topic or agent at a time.')]]);
        }

        if ($widget !== null) {
            $id = Widget::withTrashed()->where('ulid', $widget)->value('id');

            return new AnalyticsScope('admin', $user->id, AnalyticsColumns::WIDGET, $this->known($id, 'widget'), $widget);
        }

        if ($category !== null) {
            $id = Category::withTrashed()->where('ulid', $category)->value('id');

            return new AnalyticsScope('admin', $user->id, AnalyticsColumns::CATEGORY, $this->known($id, 'category'), $category);
        }

        if ($agent !== null) {
            return new AnalyticsScope('admin', $user->id, AnalyticsColumns::AGENT, (string) (int) $agent, (string) (int) $agent);
        }

        return new AnalyticsScope('admin', $user->id, AnalyticsColumns::TOTAL, '');
    }

    private function known(mixed $id, string $field): string
    {
        if (! is_int($id) && ! (is_string($id) && ctype_digit($id))) {
            throw ValidationException::withMessages([$field => [__('The selected :attribute is invalid.', ['attribute' => $field])]]);
        }

        return (string) (int) $id;
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array{0: string, 1: string}
     */
    private function range(array $input, string $today): array
    {
        $to = $this->date($this->string($input['to'] ?? null), 'to') ?? $today;
        $to = min($to, $today);
        $from = $this->date($this->string($input['from'] ?? null), 'from')
            ?? CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')->subDays(29)->format('Y-m-d');

        if ($from > $to) {
            throw ValidationException::withMessages(['from' => [__('The start of the range is after its end.')]]);
        }

        $span = (int) CarbonImmutable::createFromFormat('!Y-m-d', $from, 'UTC')->diffInDays(CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')) + 1;
        $max = max(1, (int) config('analytics.max_range_days', 731));

        if ($span > $max) {
            throw ValidationException::withMessages(['from' => [__('The range can cover at most :days days.', ['days' => $max])]]);
        }

        return [$from, $to];
    }

    private function date(?string $value, string $field): ?string
    {
        if ($value === null) {
            return null;
        }

        $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) === 1 ? CarbonImmutable::createFromFormat('!Y-m-d', $value, 'UTC') : null;

        if ($date === null || $date->format('Y-m-d') !== $value) {
            throw ValidationException::withMessages([$field => [__('The :attribute is not a valid date.', ['attribute' => $field])]]);
        }

        return $value;
    }

    private function string(mixed $value): ?string
    {
        return is_string($value) && $value !== '' ? $value : (is_int($value) ? (string) $value : null);
    }
}
