<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Notifications\Enums\PromptState;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Domain\Notifications\Support\QuietHours;
use App\Models\NotificationSetting;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Saves a member of staff's notification preferences (`PUT /me/notification-settings`): any subset of the fields, the rest stays.
 *
 * `prompt_state` is where the first-login dialog stands (decision P5-D7). `snoozed` ("Not now") hides it for `push.snooze_days` days:
 * the deadline is computed here, not by the browser's clock. Anything but `never` stamps `prompted_at`.
 */
final class UpdateNotificationSettings
{
    public function __construct(private readonly NotificationPreferences $preferences) {}

    /**
     * @param  array{sound?: bool, push_offers?: bool, push_messages?: bool, include_preview?: bool, quiet_hours?: array{enabled?: bool, start?: string, end?: string, timezone?: string}, prompt_state?: string}  $changes
     */
    public function handle(User $user, array $changes): NotificationSetting
    {
        $setting = $this->row($user);

        foreach (['sound', 'push_offers', 'push_messages', 'include_preview'] as $flag) {
            if (array_key_exists($flag, $changes)) {
                $setting->{$flag} = (bool) $changes[$flag];
            }
        }

        if (array_key_exists('quiet_hours', $changes)) {
            $current = $this->preferences->quietHours($setting, $user);
            $window = $changes['quiet_hours'];

            $setting->quiet_hours = (new QuietHours(
                enabled: (bool) ($window['enabled'] ?? $current->enabled),
                start: $window['start'] ?? $current->start,
                end: $window['end'] ?? $current->end,
                timezone: $window['timezone'] ?? $current->timezone,
            ))->toArray();
        }

        if (array_key_exists('prompt_state', $changes)) {
            $this->applyPromptState($setting, PromptState::from($changes['prompt_state']));
        }

        $setting->save();

        return $setting->refresh();
    }

    private function applyPromptState(NotificationSetting $setting, PromptState $state): void
    {
        $setting->prompt_state = $state;
        $setting->forceFill(['snoozed_until' => $state === PromptState::Snoozed ? now()->addDays(max(1, (int) config('push.snooze_days', 7))) : null]);

        if ($state !== PromptState::Never) {
            $setting->forceFill(['prompted_at' => now()]);
        }
    }

    /** The user's row, created on first use (two first-time saves racing for the one row read it again). */
    private function row(User $user): NotificationSetting
    {
        $existing = NotificationSetting::query()->where('user_id', $user->id)->first();

        if ($existing !== null) {
            return $existing;
        }

        try {
            return NotificationSetting::query()->create(['user_id' => $user->id])->refresh();
        } catch (UniqueConstraintViolationException) {
            return NotificationSetting::query()->where('user_id', $user->id)->firstOrFail();
        }
    }
}
