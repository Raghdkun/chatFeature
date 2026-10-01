<?php

namespace App\Console\Commands;

use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Domain\Audit\AuditLogger;
use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Ops: undo a `user.deleted` deactivation. The portal tells us (NATS `user.deleted`) that an account is gone and the
 * identity is deactivated for good; when that was a mistake (or the event was not genuine) the person cannot sign in
 * until this command brings the identity back. The local user is reactivated too, because older versions deactivated
 * the user along with the identity.
 *
 *   php artisan chat:auth:reactivate ada@example.com
 *   php artisan chat:auth:reactivate 42 --env=testing        # the portal's user id (sub)
 */
class ChatAuthReactivate extends Command
{
    protected $signature = 'chat:auth:reactivate
        {who : The person\'s email address, or their portal user id}
        {--env= : production or testing (default: the active environment)}
        {--force : Do not ask for confirmation}';

    protected $description = 'Reactivate a portal account that was deactivated by an upstream user.deleted event';

    public function handle(InstallState $install, SettingsRepository $settings, AuthEnvironmentRepository $environments, AuditLogger $audit): int
    {
        if (! $install->isInstalled() || $settings->string('auth.mode', 'fortify') !== 'pizzasys') {
            $this->components->error('This application is not installed in pizzasys mode; there is nothing to reactivate.');

            return self::FAILURE;
        }

        $key = (string) ($this->option('env') ?: $environments->activeKey());
        $environment = in_array($key, AuthEnvironment::KEYS, true) ? $environments->find($key) : null;

        if ($environment === null) {
            $this->components->error('Use --env=production or --env=testing with an environment that is configured.');

            return self::FAILURE;
        }

        $who = trim((string) $this->argument('who'));
        $identities = $this->deactivatedIdentities($environment, $who);

        if ($identities->isEmpty()) {
            $this->components->error('No deactivated identity matches that email or portal user id in the '.$key.' environment.');

            return self::FAILURE;
        }

        if ($identities->count() > 1) {
            $this->components->error('More than one deactivated identity matches. Pass the portal user id of the one to bring back:');

            foreach ($identities as $identity) {
                $this->line('  '.$identity->external_id.'  (deactivated '.$identity->deactivated_at?->toDateTimeString().')');
            }

            return self::FAILURE;
        }

        $identity = $identities->first();
        $user = $identity->user;

        $liveExternalId = UserExternalIdentity::query()
            ->where('user_id', $user->getKey())
            ->where('auth_environment_id', $environment->getKey())
            ->whereNull('deactivated_at')
            ->value('external_id');

        if ($liveExternalId !== null) {
            $this->components->error("This person already has a live account in the {$key} environment (portal user id {$liveExternalId}); only one can be live. Nothing was changed.");

            return self::FAILURE;
        }

        if (! $this->option('force') && ! $this->confirm("Reactivate portal user {$identity->external_id} in the {$key} environment so they can sign in again?", false)) {
            $this->components->warn('Cancelled.');

            return self::FAILURE;
        }

        try {
            DB::transaction(function () use ($identity, $user): void {
                $identity->forceFill(['active' => true, 'deactivated_at' => null, 'stale_at' => now()])->save();

                if (! $user->is_active) {
                    $user->forceFill(['is_active' => true])->save();
                }
            });
        } catch (UniqueConstraintViolationException) {
            // The person signed in with a new portal account between the check above and the update.
            $this->components->error("This person just got a live account in the {$key} environment; only one can be live. Nothing was changed.");

            return self::FAILURE;
        }

        $audit->record('auth.identity_reactivated', $user, ['environment' => $key, 'external_id' => $identity->external_id, 'via' => 'cli']);

        $this->components->info("Reactivated portal user {$identity->external_id} in the {$key} environment. Their roles are re-checked on the next sign-in.");

        return self::SUCCESS;
    }

    /**
     * @return Collection<int, UserExternalIdentity>
     */
    private function deactivatedIdentities(AuthEnvironment $environment, string $who): Collection
    {
        $query = UserExternalIdentity::query()
            ->with('user')
            ->where('auth_environment_id', $environment->getKey())
            ->whereNotNull('deactivated_at')
            ->orderByDesc('deactivated_at');

        if (str_contains($who, '@')) {
            $userIds = User::query()->whereRaw('lower(email) = ?', [mb_strtolower($who)])->pluck('id');

            return $query->whereIn('user_id', $userIds)->get();
        }

        return $query->where('external_id', $who)->get();
    }
}
