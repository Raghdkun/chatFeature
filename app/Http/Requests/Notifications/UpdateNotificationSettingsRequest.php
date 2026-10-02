<?php

namespace App\Http\Requests\Notifications;

use App\Domain\Notifications\Enums\PromptState;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Domain\Notifications\Support\QuietHours;
use App\Models\User;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * Body of `PUT /me/notification-settings`: any subset of the fields. `quiet_hours.start` / `.end` are `HH:MM`; with the window
 * switched on they must differ (equal times would mean an empty window). The rule is applied to the MERGED window (what is saved plus
 * what this request changes), so `{enabled: true, start: "07:00"}` against a saved end of `07:00` is refused as well.
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

                // Another rule already refused the shape: its message is the one to show.
                if (! is_array($window) || $validator->errors()->hasAny(['quiet_hours', 'quiet_hours.enabled', 'quiet_hours.start', 'quiet_hours.end'])) {
                    return;
                }

                $user = $this->user();

                if (! $user instanceof User) {
                    return;
                }

                $preferences = app(NotificationPreferences::class);
                $current = $preferences->quietHours($preferences->for($user), $user);
                $enabled = array_key_exists('enabled', $window) ? $window['enabled'] === true : $current->enabled;
                $start = is_string($window['start'] ?? null) ? $window['start'] : $current->start;
                $end = is_string($window['end'] ?? null) ? $window['end'] : $current->end;

                if ($enabled && $start === $end) {
                    // The field the member just changed carries the message.
                    $field = array_key_exists('end', $window) ? 'end' : (array_key_exists('start', $window) ? 'start' : 'enabled');
                    $validator->errors()->add('quiet_hours.'.$field, __('The quiet hours must start and end at different times.'));
                }
            },
        ];
    }
}
