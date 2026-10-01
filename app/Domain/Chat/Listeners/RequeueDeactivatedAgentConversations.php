<?php

namespace App\Domain\Chat\Listeners;

use App\Domain\Chat\Actions\RequeueAgentConversations;
use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Models\User;

/**
 * Decision P4-D14: when a staff member is deactivated (`deactivated`) or loses the role that lets them take chats (`role_removed`;
 * the auth layer reports an administrator who lost only the admin role as `auth_revoked`), the chats they were handling are handed
 * back to the queue. `auth_revoked` (an ended session) never does.
 */
final class RequeueDeactivatedAgentConversations
{
    public function __construct(private readonly RequeueAgentConversations $requeue) {}

    public function handle(StaffSessionRevoked $event): void
    {
        if (! in_array($event->reason, [SessionRevokeReason::Deactivated, SessionRevokeReason::RoleRemoved], true)) {
            return;
        }

        $user = User::query()->find($event->userId);

        if ($user === null) {
            return;
        }

        $this->requeue->handle($user, $event->reason->value);
    }
}
