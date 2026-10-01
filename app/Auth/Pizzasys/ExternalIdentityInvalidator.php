<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Domain\Audit\AuditLogger;
use App\Models\ExternalSession;
use App\Models\UserExternalIdentity;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;

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

    public function deactivateExternalId(string $externalId): void
    {
        foreach ($this->identities($externalId) as $identity) {
            $user = $identity->user;

            DB::transaction(function () use ($identity, $user): void {
                $identity->forceFill(['active' => false, 'deactivated_at' => now()])->save();

                if ($user->is_active) {
                    $user->forceFill(['is_active' => false])->save();
                }
            });

            // Every portal session of the person ends, whatever environment it belongs to.
            $this->sessions->revokeAllForUser($user, 'upstream_deleted');
            $user->tokens()->delete();

            $this->audit->record('auth.identity_deactivated', $user, ['environment' => $identity->environment->key, 'reason' => 'upstream_deleted']);
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
