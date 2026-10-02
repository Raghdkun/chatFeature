<?php

namespace App\Http\Requests\Analytics;

use App\Domain\Analytics\AnalyticsMetric;
use App\Domain\Analytics\Support\Buckets;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The query string of every analytics endpoint (syntax only; who may ask for what is decided by `AnalyticsQueryFactory` and the gates).
 * Unknown values of the closed lists (`interval`, `metric`, `by`, `format`) are `422`, never ignored: a typo must not silently show
 * another chart.
 */
class AnalyticsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'from' => ['sometimes', 'nullable', 'string', 'max:10'],
            'to' => ['sometimes', 'nullable', 'string', 'max:10'],
            'compare' => ['sometimes', 'nullable', 'boolean'],
            'tz' => ['sometimes', 'nullable', 'string', 'max:64', 'timezone:all_with_bc'],
            'widget' => ['sometimes', 'nullable', 'string', 'alpha_num', 'size:26'],
            'category' => ['sometimes', 'nullable', 'string', 'alpha_num', 'size:26'],
            'agent' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'interval' => ['sometimes', 'nullable', Rule::in(Buckets::INTERVALS)],
            'metric' => ['sometimes', 'nullable', 'string', 'max:400'],
            'by' => ['sometimes', 'nullable', Rule::in(['widget', 'category', 'agent'])],
            'format' => ['sometimes', 'nullable', Rule::in(['csv'])],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function filters(): array
    {
        return $this->safe()->only(['from', 'to', 'compare', 'tz', 'widget', 'category', 'agent']);
    }

    public function bucketInterval(int $days): string
    {
        $interval = $this->validated('interval');

        return is_string($interval) && $interval !== '' ? $interval : Buckets::automatic($days);
    }

    /**
     * The metrics asked for (`metric=started,handled`), in order, without repeats; at most six.
     *
     * @return list<AnalyticsMetric>
     */
    public function metrics(): array
    {
        $raw = $this->validated('metric');
        $names = is_string($raw) && $raw !== '' ? array_values(array_unique(array_filter(array_map('trim', explode(',', $raw))))) : [];
        $metrics = [];

        foreach ($names as $name) {
            $metric = AnalyticsMetric::tryFrom($name);

            if ($metric === null) {
                $this->failValidation('metric', __('Unknown metric: :name.', ['name' => mb_substr($name, 0, 40)]));
            }

            $metrics[] = $metric;
        }

        if ($metrics === []) {
            $this->failValidation('metric', __('Name at least one metric.'));
        }

        if (count($metrics) > 6) {
            $this->failValidation('metric', __('Ask for at most six metrics at a time.'));
        }

        return $metrics;
    }

    private function failValidation(string $field, string $message): never
    {
        throw ValidationException::withMessages([$field => [$message]]);
    }
}
