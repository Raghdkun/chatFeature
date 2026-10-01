<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\UserRole;
use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Shadow\ShadowSyncResult;
use App\Auth\Shadow\ShadowUserSync;
use App\Domain\Audit\AuditLogger;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Install\Support\PizzasysAnswers;
use App\Models\AuthEnvironment;
use Illuminate\Support\Facades\DB;

/**
 * Step 5 (mode `pizzasys`): the first administrator is the portal administrator the wizard verified: a shadow user
 * plus its external identity in the active environment, flagged `is_admin` (and agent). Runs under the same key as the
 * mode-1 step (`create-admin`); idempotent because the shadow sync is keyed by (environment, portal user id).
 */
final class CreatePortalAdminStep implements InstallStep
{
    public function __construct(
        private readonly ShadowUserSync $shadow,
        private readonly AuditLogger $audit,
    ) {}

    public function key(): string
    {
        return 'create-admin';
    }

    public function label(): string
    {
        return 'Create the first administrator';
    }

    /**
     * @return list<string>
     */
    public function modes(): array
    {
        return ['pizzasys'];
    }

    public function run(InstallContext $context): StepResult
    {
        $answers = PizzasysAnswers::from($context->authEnvironments);
        $admin = $answers->portalAdmin();

        if ($admin === null) {
            return StepResult::needsInput(['portal-admin']);
        }

        $environment = AuthEnvironment::query()->where('key', $answers->activeKey())->first();

        if ($environment === null) {
            return StepResult::failed('The portal environment has not been written yet. Run the default settings step first.');
        }

        $result = DB::transaction(function () use ($environment, $admin): ShadowSyncResult {
            $synced = $this->shadow->upsert($environment, new PortalClaims($admin['sub'], $admin['name'], $admin['email'], $admin['roles'], $admin['permissions']));

            if ($synced->isSynced() && $synced->user !== null) {
                $synced->user->forceFill(['is_admin' => true, 'is_agent' => true, 'is_active' => true, 'role' => UserRole::Admin])->save();
                $this->audit->record('install.admin_created', $synced->user, ['source' => 'pizzasys', 'environment' => $environment->key]);
            }

            return $synced;
        });

        if (! $result->isSynced()) {
            return StepResult::failed(match ($result->refusal) {
                ShadowSyncResult::EMAIL_CONFLICT => 'A local account with the portal administrator\'s email already exists. Use an empty database.',
                default => 'The portal administrator account could not be created ('.($result->refusal ?? 'unknown').').',
            });
        }

        return StepResult::ok();
    }
}
