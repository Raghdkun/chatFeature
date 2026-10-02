<?php

use App\Domain\Chat\Realtime\Channels\AdminChannel;
use App\Domain\Chat\Realtime\Channels\ConversationChannel;
use App\Domain\Chat\Realtime\Channels\PresenceStaffChannel;
use App\Domain\Chat\Realtime\Channels\StaffChannel;
use App\Domain\WhatsApp\Support\WhatsAppAdminChannel;
use App\Domain\WhatsApp\Support\WhatsAppRealtime;
use App\Models\User;
use Illuminate\Support\Facades\Broadcast;

/*
|--------------------------------------------------------------------------
| Broadcast channels (docs/contracts/realtime-events.md, docs/realtime.md)
|--------------------------------------------------------------------------
| `POST /broadcasting/auth` (the `web` group: session cookie with `session.valid` and `chat.access`) authorises STAFF. A Sanctum bearer
| (mobile) works there too, through the `sanctum` guard. A channel without a matching entry, or a guard that finds no user, is
| refused (403): there is no default allow.
|
| VISITORS never come through this file. Their only channel, `private-conversation.{ulid}` of the conversation their session is bound
| to, is authorised by `POST /api/v1/public/broadcasting/auth` (bearer `vt_...`, `BroadcastingAuthController`).
|
| `private-whatsapp-admin` (P6, WhatsApp inbox and session status) is for ACTIVE ADMINISTRATORS only, never agents (decision P6-D1).
*/

$staffGuards = ['guards' => ['web', 'sanctum']];

// The starter kit's per-user channel (notifications): kept, limited to active accounts.
Broadcast::channel('App.Models.User.{id}', function (?User $user, string $id): bool {
    return $user instanceof User && $user->is_active && ctype_digit($id) && (string) $user->id === $id;
}, $staffGuards);

// private-staff.{userId}: that staff member's offers, counters and `session.revoked`.
Broadcast::channel('staff.{userId}', StaffChannel::class, $staffGuards);

// presence-staff: the roster of signed-in staff, member info {id, name, avatarUrl, status}.
Broadcast::channel('staff', PresenceStaffChannel::class, $staffGuards);

// private-conversation.{ulid}: staff who may see the conversation (ConversationPolicy::viewAsStaff).
Broadcast::channel('conversation.{ulid}', ConversationChannel::class, $staffGuards);

// private-admin: administrators.
Broadcast::channel('admin', AdminChannel::class, $staffGuards);

// private-whatsapp-admin: active administrators only (the WhatsApp inbox and session status; agents never).
Broadcast::channel(WhatsAppRealtime::ADMIN_CHANNEL, WhatsAppAdminChannel::class, $staffGuards);
