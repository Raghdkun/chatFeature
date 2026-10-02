<?php

namespace App\Domain\WhatsApp\Policies;

use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;

/**
 * Who may use WhatsApp (decision P6-D1): ONLY active administrators, for every ability and every model. Agents, accounts without a
 * chat role, deactivated administrators, guests (the abilities take a non-nullable `User`, so Laravel denies a guest before the policy
 * runs) and visitors (who are not `User`s at all) are always turned away. Registered for `WaChat`, `WaMessage` and `WhatsAppSession`
 * by `WhatsAppServiceProvider`.
 *
 * `Gate::before` (AuthModeServiceProvider) already grants every ability to an active admin; the methods say the same on their own so
 * a call to the policy (or a change to the `Gate::before` rule) can never open WhatsApp to anybody else. State checks (the session is
 * `ready`, the chat was started by the customer, the pacing caps) belong to the actions, which re-check them in guarded code: this
 * policy is not the place for them.
 */
final class WhatsAppPolicy
{
    /** The inbox and the settings page: list chats, sessions and the connection state. */
    public function viewAny(User $user): bool
    {
        return $this->admin($user);
    }

    public function view(User $user, WaChat|WaMessage|WhatsAppSession|null $subject = null): bool
    {
        return $this->admin($user);
    }

    /** Send a reply into a chat. */
    public function reply(User $user, ?WaChat $chat = null): bool
    {
        return $this->admin($user);
    }

    /** Create, start, stop, delete a session and read its QR. */
    public function manageSessions(User $user, ?WhatsAppSession $session = null): bool
    {
        return $this->admin($user);
    }

    /** The `whatsapp.*` settings (OpenWA address, API key, pacing, hand-off text) and the connection test. */
    public function manageSettings(User $user): bool
    {
        return $this->admin($user);
    }

    /** Archive or re-open a chat, mark it read. */
    public function archive(User $user, ?WaChat $chat = null): bool
    {
        return $this->admin($user);
    }

    /** Delete a chat for good with its messages and stored images (erasure on request, retention). */
    public function delete(User $user, ?WaChat $chat = null): bool
    {
        return $this->admin($user);
    }

    /** Export a chat or the whole inbox. */
    public function export(User $user, ?WaChat $chat = null): bool
    {
        return $this->admin($user);
    }

    private function admin(User $user): bool
    {
        return $user->is_active && $user->is_admin;
    }
}
