<?php

namespace App\Http\Requests\Notifications;

use App\Domain\Notifications\Enums\PromptState;
use App\Domain\Notifications\Support\QuietHours;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * Body of `PUT /me/notification-settings`: any subset of the fields. `quiet_hours.start` / `.end` are `HH:MM`; with the window
 * switched on they must differ (equal times would mean an empty window), counting what is already saved for the field not sent.
 */
class UpdateNotificationSettingsRequest extends FormRequest
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
            'sound' => ['sometimes', 'boolean'],
            'push_offers' => ['sometimes', 'boolean'],
            'push_messages' => ['sometimes', 'boolean'],
            'include_preview' => ['sometimes', 'boolean'],
            'quiet_hours' => ['sometimes', 'array'],
            'quiet_hours.enabled' => ['sometimes', 'boolean'],
            'quiet_hours.start' => ['sometimes', 'string', 'regex:'.QuietHours::TIME_PATTERN],
            'quiet_hours.end' => ['sometimes', 'string', 'regex:'.QuietHours::TIME_PATTERN],
            'quiet_hours.timezone' => ['sometimes', 'string', 'max:64', 'timezone:all_with_bc'],
            'prompt_state' => ['sometimes', 'string', Rule::enum(PromptState::class)],
        ];
    }

    /**
     * @return list<callable(Validator): void>
     */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $window = $this->input('quiet_hours');

                if (! is_array($window) || ($window['enabled'] ?? false) !== true || ! isset($window['start'], $window['end'])) {
                    return;
                }

                if ($window['start'] === $window['end']) {
                    $validator->errors()->add('quiet_hours.end', __('The quiet hours must start and end at different times.'));
                }
            },
        ];
    }
}
