<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\UserRole;
use App\Domain\Audit\AuditLogger;
use App\Domain\Catalog\Actions\EnsureGeneralCategory;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Step 5 (mode `fortify`): the first administrator.
 *
 * Idempotent: an existing account with the wizard's email is promoted/updated instead of duplicated.
 * The stored password hash is scrubbed from install-state.json once the user exists.
 */
final class CreateAdminStep implements InstallStep
{
    public const AUDIT_ACTION = 'install.admin_created';

    public function __construct(private readonly AuditLogger $audit) {}

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
        return ['fortify'];
    }

    public function run(InstallContext $context): StepResult
    {
        $admin = $context->admin;

        if ($admin === null) {
            return StepResult::needsInput(['admin']);
        }

        $existing = User::query()->where('email', $admin['email'])->first();

        // The wizard may only (re)write the administrator it created itself, for instance when the answer is
        // changed after the step already ran. A database that holds any other account is not a fresh install:
        // never promote or overwrite those.
        $count = User::query()->count();
        $only = $count === 1 ? User::query()->first() : null;

        if ($only !== null && $this->createdByWizard($only)) {
            $existing = $only;
        } elseif ($count > 0) {
            return StepResult::failed('This database already contains user accounts. The installer will not modify existing accounts; use an empty database.');
        }

        if ($admin['password_hash'] === null && $existing === null) {
            return StepResult::needsInput(['admin'], 'The administrator password must be entered again.');
        }

        DB::transaction(function () use ($admin, $existing): void {
            $user = $existing ?? new User;

            $user->forceFill([
                'name' => $admin['name'],
                'email' => $admin['email'],
                'role' => UserRole::Admin,
                'is_admin' => true,
                'is_agent' => true,
                'is_active' => true,
                'auth_source' => 'local',
                'email_verified_at' => $user->email_verified_at ?? now(),
            ])->save();

            if ($admin['password_hash'] !== null) {
                // Written without the model's `hashed` cast: the value is already a hash.
                User::query()->whereKey($user->getKey())->update(['password' => $admin['password_hash']]);
            }

            // The administrator takes chats too (`is_agent`): put them on the seeded "General" category (the seed step ran before this
            // one). Otherwise the first visitor always gets "no agent is available" and nothing says why.
            Category::query()->where('slug', EnsureGeneralCategory::SLUG)->first()?->users()->syncWithoutDetaching([$user->getKey()]);

            // Provenance: lets a later re-run recognise "the administrator this wizard created" (see above).
            $this->audit->record(self::AUDIT_ACTION, $user->refresh());
        });

        $context->state->mutate(function (array $state): array {
            if ($state['admin'] !== null) {
                $state['admin']['password_hash'] = null;
            }

            return $state;
        });

        return StepResult::ok();
    }

    private function createdByWizard(User $user): bool
    {
        return AuditLog::query()
            ->where('action', self::AUDIT_ACTION)
            ->where('subject_type', User::class)
            ->where('subject_id', (string) $user->getKey())
            ->exists();
    }
}
