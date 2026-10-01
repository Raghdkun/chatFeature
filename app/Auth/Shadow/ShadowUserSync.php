<?php

namespace App\Auth\Shadow;

use App\Auth\Enums\UserRole;
use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use App\Support\PersonName;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Keeps a local "shadow" user for every portal account that signs in.
 *
 * Identity key is `(environment, external_id = pizzasys sub)`, never the email. Only when no identity exists yet is
 * the account linked by email to an existing portal user (`auth_source = pizzasys`), and only when that user has no
 * LIVE (not deactivated) identity in this environment: a second portal account that merely shares the email must never
 * inherit the first one's local account, chats or roles (the login is refused instead). Otherwise a new user with a
 * NULL password is created. Name and email follow the portal on every sync. An identity with `deactivated_at`, or a
 * deactivated local user, can never sign in. Roles are NOT touched here: {@see PizzasysRoleResolver}
 * derives them afterwards, from the identity this sync returns. The database backs the one-live-identity rule with a
 * unique key, and the matched user row is locked while the check and the insert run.
 */
final class ShadowUserSync
{
    /**
     * @param  bool  $createIfMissing  false = only refresh accounts that already exist (used when the portal says the
     *                                 person has no chat role, so such people never get a local row).
     */
    public function upsert(AuthEnvironment $environment, PortalClaims $claims, bool $createIfMissing = true): ShadowSyncResult
    {
        try {
            return DB::transaction(fn (): ShadowSyncResult => $this->sync($environment, $claims, $createIfMissing));
        } catch (UniqueConstraintViolationException) {
            // Two first logins raced: the other one won, so this one now finds its rows ...
            try {
                return DB::transaction(fn (): ShadowSyncResult => $this->sync($environment, $claims, $createIfMissing));
            } catch (UniqueConstraintViolationException) {
                // ... and when the database still says no, somebody else owns the slot: refuse instead of crashing.
                return ShadowSyncResult::refused(ShadowSyncResult::IDENTITY_CONFLICT);
            }
        }
    }

    private function sync(AuthEnvironment $environment, PortalClaims $claims, bool $createIfMissing): ShadowSyncResult
    {
        $email = mb_strtolower(trim($claims->email));

        $identity = UserExternalIdentity::query()
            ->where('auth_environment_id', $environment->getKey())
            ->where('external_id', $claims->sub)
            ->first();

        $created = false;

        if ($identity !== null) {
            if ($identity->isDeactivated()) {
                return ShadowSyncResult::refused(ShadowSyncResult::IDENTITY_DEACTIVATED, $identity->user);
            }

            $user = $identity->user;
        } else {
            $user = User::query()->whereRaw('lower(email) = ?', [$email])->lockForUpdate()->first();

            if ($user !== null && ! $user->isPortalUser()) {
                return ShadowSyncResult::refused(ShadowSyncResult::EMAIL_CONFLICT);
            }

            if ($user !== null && $this->hasLiveIdentity($user, $environment)) {
                // Only ids and the outcome are logged: never the email, a name or a token.
                Log::warning('Portal login refused: the user behind this email already has a live identity in this environment.', [
                    'environment' => $environment->key,
                    'external_id' => $claims->sub,
                    'user_id' => $user->getKey(),
                    'outcome' => ShadowSyncResult::IDENTITY_CONFLICT,
                ]);

                return ShadowSyncResult::refused(ShadowSyncResult::IDENTITY_CONFLICT);
            }

            if ($user === null) {
                if (! $createIfMissing) {
                    return ShadowSyncResult::refused(ShadowSyncResult::NOT_CREATED);
                }

                $user = $this->createUser($claims, $email);
                $created = true;
            }
        }

        if (! $user->is_active) {
            return ShadowSyncResult::refused(ShadowSyncResult::ACCOUNT_DEACTIVATED, $user);
        }

        if (! $created) {
            $this->refreshUser($user, $claims, $email);
        }

        $identity ??= new UserExternalIdentity([
            'user_id' => $user->getKey(),
            'auth_environment_id' => $environment->getKey(),
            'external_id' => $claims->sub,
        ]);

        $identity->forceFill([
            'roles' => $claims->roles,
            'permissions' => $claims->permissions,
            'active' => true,
            'last_verified_at' => now(),
            'stale_at' => null,
        ])->save();

        return ShadowSyncResult::synced($user, $identity, $created);
    }

    private function hasLiveIdentity(User $user, AuthEnvironment $environment): bool
    {
        return UserExternalIdentity::query()
            ->where('user_id', $user->getKey())
            ->where('auth_environment_id', $environment->getKey())
            ->whereNull('deactivated_at')
            ->exists();
    }

    private function createUser(PortalClaims $claims, string $email): User
    {
        $user = new User;
        $user->forceFill([
            'name' => $claims->name,
            'display_name' => $this->displayName($claims),
            'email' => $email,
            'password' => null,
            'email_verified_at' => now(),
            'auth_source' => 'pizzasys',
            'role' => UserRole::Agent,
            'is_admin' => false,
            'is_agent' => false,
            'is_active' => true,
        ])->save();

        return $user;
    }

    /** What visitors will see: the portal name, but never an e-mail address (a portal that sends the address as the name). */
    private function displayName(PortalClaims $claims): string
    {
        return PersonName::visitorFacing([$claims->name], $claims->email);
    }

    private function refreshUser(User $user, PortalClaims $claims, string $email): void
    {
        $previousName = $user->name;
        $attributes = ['name' => $claims->name];
        $displayName = $this->displayName($claims);

        // A display name nobody customised follows the portal name (and one that is an address, stored by an older version, is fixed).
        if ($user->display_name === null || $user->display_name === '' || $user->display_name === $previousName || str_contains($user->display_name, '@')) {
            $attributes['display_name'] = $displayName;
        }

        $taken = mb_strtolower($user->email) !== $email
            && User::query()->whereRaw('lower(email) = ?', [$email])->whereKeyNot($user->getKey())->exists();

        if (! $taken) {
            $attributes['email'] = $email;
        }

        if ($user->email_verified_at === null) {
            $attributes['email_verified_at'] = now();
        }

        $user->forceFill($attributes);

        if ($user->isDirty()) {
            $user->save();
        }
    }
}
