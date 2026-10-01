<?php

namespace App\Domain\Chat\Realtime\Channels;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Str;

/**
 * `private-conversation.{ulid}` for STAFF (guards `web`, `sanctum`): whoever `ConversationPolicy::viewAsStaff()` lets see the
 * conversation, that is an active admin, the assigned agent, or an agent holding an open offer while it is still `queued`.
 * Visitors do not come through here: their bearer token is checked by `POST /api/v1/public/broadcasting/auth`
 * (`BroadcastingAuthController`), which authorises only the conversation their session is bound to.
 */
final class ConversationChannel
{
    public function __construct(
        private readonly StaffAccess $access,
        private readonly ConversationPolicy $policy,
    ) {}

    public function join(?Authenticatable $user, string $ulid): bool
    {
        $staff = $this->access->staff($user);

        if (! $staff instanceof User || ! ChannelName::isPrivate() || ! Str::isUlid($ulid)) {
            return false;
        }

        $conversation = Conversation::query()->where('ulid', strtolower($ulid))->first();

        return $conversation !== null && $this->policy->viewAsStaff($staff, $conversation);
    }
}
