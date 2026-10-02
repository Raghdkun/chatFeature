<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Data\Notifications\NotificationSettingsData;
use App\Domain\Notifications\Actions\UpdateNotificationSettings;
use App\Domain\Notifications\Channels\WebPushChannel;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Http\Requests\Notifications\UpdateNotificationSettingsRequest;
use App\Models\NotificationSetting;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `GET/PUT /me/notification-settings`: the caller's own notification preferences and first-login dialog state (decisions P5-D4, P5-D7).
 * There is no id in the URL: a user can only ever read and change their own row.
 */
class NotificationSettingsController extends ChatStaffController
{
    public function show(Request $request, NotificationPreferences $preferences): JsonResponse
    {
        $user = $this->staff($request);

        return $this->present($preferences->for($user), $user, $preferences);
    }

    public function update(UpdateNotificationSettingsRequest $request, UpdateNotificationSettings $action, NotificationPreferences $preferences): JsonResponse
    {
        $user = $this->staff($request);

        /** @var array{sound?: bool, push_offers?: bool, push_messages?: bool, include_preview?: bool, quiet_hours?: array{enabled?: bool, start?: string, end?: string, timezone?: string}, prompt_state?: string} $changes */
        $changes = $request->validated();

        return $this->present($action->handle($user, $changes), $user, $preferences);
    }

    private function present(NotificationSetting $setting, User $user, NotificationPreferences $preferences): JsonResponse
    {
        return $this->data(NotificationSettingsData::fromModel($setting, $user, $preferences, WebPushChannel::vapidConfigured()));
    }
}
