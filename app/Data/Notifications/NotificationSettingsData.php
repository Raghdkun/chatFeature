<?php

namespace App\Data\Notifications;

use App\Domain\Notifications\Enums\PromptState;
use App\Domain\Notifications\Services\NotificationPreferences;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\NotificationSetting;
use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A member of staff's notification preferences (`GET/PUT /me/notification-settings`) and where they are in the first-login dialog.
 * `previewsAllowed` is the administrator's switch (`notifications.push_include_preview`): off, a push never carries visitor text
 * whatever `includePreview` says. `pushAvailable` is false when the VAPID keys are not configured (the page explains and the
 * dialog never opens). `snoozeDays` is how long "Not now" hides the first-login dialog.
 */
#[TypeScript]
class NotificationSettingsData extends Data
{
    public function __construct(
        public bool $sound,
        public bool $pushOffers,
        public bool $pushMessages,
        public bool $includePreview,
        public QuietHoursData $quietHours,
        public PromptState $promptState,
        public ?string $promptedAt,
        public ?string $snoozedUntil,
        public bool $previewsAllowed,
        public bool $pushAvailable,
        public int $snoozeDays,
    ) {}

    public static function fromModel(NotificationSetting $setting, User $user, NotificationPreferences $preferences, bool $pushAvailable): self
    {
        return new self(
            sound: $setting->sound,
            pushOffers: $setting->push_offers,
            pushMessages: $setting->push_messages,
            includePreview: $setting->include_preview,
            quietHours: QuietHoursData::fromValue($preferences->quietHours($setting, $user)),
            promptState: $setting->prompt_state,
            promptedAt: Timestamps::iso($setting->prompted_at),
            snoozedUntil: Timestamps::iso($setting->snoozed_until),
            previewsAllowed: settings()->bool('notifications.push_include_preview', true),
            pushAvailable: $pushAvailable,
            snoozeDays: max(1, (int) config('push.snooze_days', 7)),
        );
    }
}
