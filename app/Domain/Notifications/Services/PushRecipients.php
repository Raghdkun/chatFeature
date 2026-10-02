<?php

namespace App\Domain\Notifications\Services;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Support\PushRecipient;
use App\Models\DeviceToken;
use App\Models\NotificationSetting;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Decides WHO gets an OS push (decision P5-D5): of the users a push is about, those who are active staff, have at least one device,
 * allow this kind of push, are outside their quiet hours and are not looking at the dashboard right now (an agent in front of the
 * inbox gets the in-page toast and sound; a push on top would double the alert).
 */
final class PushRecipients
{
    public function __construct(
        private readonly NotificationPreferences $preferences,
        private readonly DashboardVisibility $visibility,
    ) {}

    /**
     * @param  list<int>  $userIds
     * @return list<PushRecipient> in the order of `$userIds`
     */
    public function eligible(array $userIds, PushType $type): array
    {
        $userIds = array_values(array_unique($userIds));

        if ($userIds === []) {
            return [];
        }

        $withDevices = $this->withDevices($userIds);

        if ($withDevices === []) {
            return [];
        }

        /** @var array<int, User> $users */
        $users = User::query()
            ->whereKey($withDevices)
            ->where('is_active', true)
            ->where(fn (Builder $query) => $query->where('is_admin', true)->orWhere('is_agent', true))
            ->get()
            ->keyBy('id')
            ->all();

        /** @var array<int, NotificationSetting> $settings */
        $settings = NotificationSetting::query()->whereIn('user_id', array_keys($users))->get()->keyBy('user_id')->all();
        $window = (int) config('push.visible_window_seconds', 60);
        $eligible = [];

        foreach ($userIds as $userId) {
            $user = $users[$userId] ?? null;

            if ($user === null) {
                continue;
            }

            $setting = $settings[$userId] ?? new NotificationSetting(['user_id' => $userId]);

            if (! $this->allows($setting, $type)
                || $this->preferences->inQuietHours($setting, $user)
                || $this->visibility->isViewingDashboard($userId, $window)) {
                continue;
            }

            $eligible[] = new PushRecipient($user, $setting);
        }

        return $eligible;
    }

    /** Whether the preference for this kind of push is on (the dismiss and test pushes are not preferences). */
    private function allows(NotificationSetting $setting, PushType $type): bool
    {
        return match ($type) {
            PushType::Offer => $setting->push_offers,
            PushType::Message => $setting->push_messages,
            default => true,
        };
    }

    /**
     * Of these users, the ones with a browser subscription (or, when FCM is on, a device token).
     *
     * @param  list<int>  $userIds
     * @return list<int>
     */
    private function withDevices(array $userIds): array
    {
        $ids = PushSubscription::query()->whereIn('user_id', $userIds)->distinct()->pluck('user_id')->all();

        if (config('push.fcm.enabled') === true) {
            $ids = [...$ids, ...DeviceToken::query()->whereIn('user_id', $userIds)->distinct()->pluck('user_id')->all()];
        }

        return array_values(array_unique(array_map(intval(...), $ids)));
    }
}
