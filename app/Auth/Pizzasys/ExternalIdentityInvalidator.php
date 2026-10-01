<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Shadow\ShadowUserSync;
use App\Domain\Audit\AuditLogger;
use App\Models\ExternalSession;
use App\Models\UserExternalIdentity;
use Illuminate\Database\Eloquent\Collection;

/**
 * Reacts to what the portal tells us changed (the NATS consumer, track 2B) and to local role-mapping changes.
 * Only the ACTIVE environment's identities are touched: a portal user id of one environment says nothing about the
 * same number in the other one.
 */
final class ExternalIdentityInvalidator implements IdentityInvalidator
{
    public function __construct(
        private readonly AuthEnvironmentRepository $environments,
        private readonly VerifyCache $cache,
        private readonly ExternalSessionStore $sessions,
        private readonly AuditLogger $audit,
    ) {}

    public function flushForExternalId(string $externalId): void
    {
        foreach ($this->identities($externalId) as $identity) {
            $identity->forceFill(['stale_at' => now()])->save();

            foreach ($this->liveSessions($identity) as $session) {
                $token = $session->token;

                if ($token !== null) {
                    $this->cache->forget($identity->environment->key, $token);
                }
            }
        }
    }

    /**
     * `user.deleted`: only the IDENTITY (this portal account in the active environment) is deactivated and its sessions
     * and tokens revoked. The local user stays active: a forged or mistaken event must not lock a person out for good,
     * and a portal account re-created with the same email can link to the user again once the old identity is gone
     * ({@see ShadowUserSync}). `php artisan chat:auth:reactivate` undoes a wrong deactivation.
     */
    public function deactivateExternalId(string $externalId): void
    {
        foreach ($this->identities($externalId) as $identity) {
            if ($identity->isDeactivated()) {
                continue;
            }

            $user = $identity->user;

            $identity->forceFill(['active' => false, 'deactivated_at' => now()])->save();

            // Sessions of this identity only (their Sanctum tokens go with them); other identities of the user are theirs.
            $this->sessions->revokeForIdentity($identity, 'upstream_deleted');

            $this->audit->record('auth.identity_deactivated', $user, [
                'environment' => $identity->environment->key,
                'external_id' => $identity->external_id,
                'reason' => 'upstream_deleted',
            ]);
        }
    }

    public function flushAll(): void
    {
        UserExternalIdentity::query()->whereNull('stale_at')->update(['stale_at' => now()]);
        $this->cache->flushAll();
    }

    /**
     * @return Collection<int, UserExternalIdentity>
     */
    private function identities(string $externalId): Collection
    {
        $environment = $this->environments->active();

        if ($environment === null || $externalId === '') {
            return new Collection;
        }

        return UserExternalIdentity::query()
            ->with(['user', 'environment'])
            ->where('auth_environment_id', $environment->getKey())
            ->where('external_id', $externalId)
            ->get();
    }

    /**
     * @return Collection<int, ExternalSession>
     */
    private function liveSessions(UserExternalIdentity $identity): Collection
    {
        return ExternalSession::query()->where('identity_id', $identity->getKey())->whereNull('revoked_at')->get();
    }
}
