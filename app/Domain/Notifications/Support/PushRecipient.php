<?php

namespace App\Domain\Notifications\Support;

use App\Models\NotificationSetting;
use App\Models\User;

/** A member of staff a push goes to, with the preferences that shaped it (a default row when they never saved any). */
final readonly class PushRecipient
{
    public function __construct(
        public User $user,
        public NotificationSetting $setting,
    ) {}
}
