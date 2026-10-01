<?php

namespace App\Auth\Pizzasys\Actions;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\ExternalSessionStore;
use App\Auth\Pizzasys\NatsRestartSignal;
use App\Auth\Pizzasys\VerifyCache;
use App\Domain\Audit\AuditLogger;
use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * The state change of an environment switch, with no network and no credential check (callers do those): make the
 * target environment active, revoke every portal session that belongs to the other one (the actor's included), drop
 * the verify caches, tell the NATS consumer to reconnect and leave an audit row.
 */
final class SwitchActiveEnvironment
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuthEnvironmentRepository $environments,
        private readonly ExternalSessionStore $sessions,
        private readonly VerifyCache $verifyCache,
        private readonly NatsRestartSignal $restart,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  'dashboard'|'cli'  $via
     * @return int How many portal sessions were revoked.
     */
    public function __invoke(AuthEnvironment $target, ?User $actor, string $via): int
    {
        $from = $this->environments->activeKey();

        $revoked = DB::transaction(function () use ($target, $actor): int {
            $this->settings->set('auth.pizzasys.active_env', $target->key, null, $actor?->getKey());

            return $this->sessions->revokeOutsideEnvironment((int) $target->getKey(), 'environment_switched');
        });

        $this->environments->syncNatsEnabled();
        $this->verifyCache->flushAll();
        $this->restart->request();

        $this->audit->record(
            'auth.environment_activated',
            $target,
            ['from' => $from, 'to' => $target->key, 'via' => $via, 'revoked_sessions' => $revoked],
            $actor,
        );

        return $revoked;
    }
}
