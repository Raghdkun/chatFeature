<?php

namespace App\Domain\Agents\Actions;

use App\Auth\Enums\UserRole;
use App\Domain\Audit\AuditLogger;
use App\Domain\Catalog\Actions\SyncUserCategories;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Creates a local staff account (mode 1 only; the caller checks the mode): an active agent who can sign in
 * straight away. Staff are never gated on email verification.
 */
final class CreateLocalAgent
{
    public function __construct(
        private readonly SyncUserCategories $categories,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array{name: string, email: string, password: string}  $attributes
     * @param  list<string>  $categoryUlids
     */
    public function handle(array $attributes, array $categoryUlids, ?User $actor = null): User
    {
        return DB::transaction(function () use ($attributes, $categoryUlids, $actor): User {
            $user = new User;
            $user->forceFill([
                'name' => $attributes['name'],
                'email' => $attributes['email'],
                'password' => $attributes['password'],
                'role' => UserRole::Agent,
                'is_admin' => false,
                'is_agent' => true,
                'is_active' => true,
                'auth_source' => 'local',
                'email_verified_at' => now(),
            ])->save();

            if ($categoryUlids !== []) {
                $this->categories->handle($user, $categoryUlids, $actor, 'agent.categories_updated');
            }

            $this->audit->record('agent.created', $user, ['email' => $user->email, 'name' => $user->name], $actor);

            return $user->refresh();
        });
    }
}
