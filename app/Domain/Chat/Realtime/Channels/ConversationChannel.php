<?php

namespace App\Domain\Chat\Realtime\Channels;

use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Realtime\Sockets\ConversationGrants;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Str;

/**
 * `private-conversation.{ulid}` for STAFF (guards `web`, `sanctum`): whoever `ConversationPolicy::viewAsStaff()` lets see the
 * conversation, that is an active admin, the assigned agent, or an agent holding an open offer while it is still `queued`.
 * Visitors do not come through here: their bearer token is checked by `POST /api/v1/public/broadcasting/auth`
 * (`BroadcastingAuthController`), which authorises only the conversation their session is bound to.
 *
 * An agent's grant is recorded (`ConversationGrants`): when the chat is transferred away, claimed by somebody else or handed back to
 * the queue, the grants are judged again and a member who lost the conversation has their sockets closed.
 */
final class ConversationChannel
{
    public function __construct(
        private readonly StaffAccess $access,
        private readonly ConversationPolicy $policy,
        private readonly ConversationGrants $grants,
    ) {}

    public function join(?Authenticatable $user, string $ulid): bool
    {
        $staff = $this->access->staff($user);

        if (! $staff instanceof User || ! ChannelName::isPrivate() || ! Str::isUlid($ulid)) {
            return false;
        }

        $conversation = Conversation::query()->where('ulid', strtolower($ulid))->first();

        if ($conversation === null || ! $this->policy->viewAsStaff($staff, $conversation)) {
            return false;
        }

        // The signed subscription below may now be used: remember it, so a later loss of access can close the socket.
        $this->grants->record($staff, $conversation);

        return true;
    }
}
