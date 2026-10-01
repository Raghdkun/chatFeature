<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\UserRole;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
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
        });

        $context->state->mutate(function (array $state): array {
            if ($state['admin'] !== null) {
                $state['admin']['password_hash'] = null;
            }

            return $state;
        });

        return StepResult::ok();
    }
}
