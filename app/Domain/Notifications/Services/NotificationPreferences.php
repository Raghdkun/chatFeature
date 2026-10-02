<?php

namespace App\Domain\Notifications\Services;

use App\Domain\Notifications\Support\QuietHours;
use App\Models\NotificationSetting;
use App\Models\User;
use Carbon\CarbonInterface;

/**
 * Reads a member of staff's notification preferences (a user without a row has the defaults) and answers the questions the push
 * listeners ask of them.
 */
final class NotificationPreferences
{
    /** The row of the user, or a default one that is not saved. */
    public function for(User|int $user): NotificationSetting
    {
        $id = $user instanceof User ? $user->id : $user;

        return NotificationSetting::query()->where('user_id', $id)->first() ?? new NotificationSetting(['user_id' => $id]);
    }

    public function quietHours(NotificationSetting $setting, ?User $user = null): QuietHours
    {
        return QuietHours::fromArray($setting->quiet_hours, $this->fallbackTimezone($user));
    }

    public function inQuietHours(NotificationSetting $setting, ?User $user = null, ?CarbonInterface $at = null): bool
    {
        return $this->quietHours($setting, $user)->isActiveAt($at ?? now());
    }

    /**
     * Whether a notification may carry text the visitor wrote (their first message): the administrator's switch
     * (`notifications.push_include_preview`) AND the member of staff's own.
     */
    public function includesPreview(NotificationSetting $setting): bool
    {
        return settings()->bool('notifications.push_include_preview', true) && $setting->include_preview;
    }

    /** The timezone a window without one is read in: the user's own, else the application's. */
    public function fallbackTimezone(?User $user = null): string
    {
        $own = $user?->timezone;

        if (is_string($own) && QuietHours::validTimezone($own)) {
            return $own;
        }

        $app = settings()->string('app.timezone', 'UTC');

        return QuietHours::validTimezone($app) ? $app : 'UTC';
    }
}
