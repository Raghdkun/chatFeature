<?php

namespace App\Domain\Chat\Realtime\Channels;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\SessionContext;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Who counts as signed-in staff for a channel: an active account that still has a chat role. `/broadcasting/auth` runs in the
 * `web` group, so for a browser session `session.valid` and `chat.access` have already judged the request; a Sanctum bearer
 * (mobile) is resolved by the channel's guards instead and never passed through those middleware, so its session is judged here
 * with the same verdict (a token whose portal session was revoked, or whose portal cannot be asked any more, is refused).
 */
final class StaffAccess
{
    public function __construct(
        private readonly AuthDriver $driver,
        private readonly Request $request,
    ) {}

    public function staff(?Authenticatable $user): ?User
    {
        $token = $user instanceof User ? $user->currentAccessToken() : null;

        if (! $user instanceof User || ! $user->is_active || ! $user->hasChatAccess()) {
            return null;
        }

        // Only a real API token (mobile) is judged here; a browser session passed `session.valid` in the web group already.
        if ($token instanceof PersonalAccessToken) {
            $verdict = $this->driver->validateSession($user, new SessionContext(
                ip: $this->request->ip(),
                userAgent: $this->request->userAgent(),
                sanctumTokenId: (int) $token->getKey(),
            ));

            if ($verdict === SessionVerdict::Revoked || $verdict === SessionVerdict::Unavailable) {
                return null;
            }
        }

        return $user;
    }

    public function admin(?Authenticatable $user): ?User
    {
        $staff = $this->staff($user);

        return $staff?->is_admin ? $staff : null;
    }
}
