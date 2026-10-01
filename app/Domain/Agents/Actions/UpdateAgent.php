<?php

namespace App\Domain\Agents\Actions;

use App\Auth\Enums\UserRole;
use App\Domain\Agents\AuthModeGuard;
use App\Domain\Audit\AuditLogger;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Updates a staff member. `max_concurrent_chats` is always editable; `is_active` and `is_agent` only in mode 1
 * (otherwise `409 managed_by_auth_portal`). An admin cannot deactivate their own account, and agents (role `agent`)
 * always take chats: only admins may switch `is_agent` off (an admin who does not take chats). Switching it off also
 * drops the categories the account served: only agents serve categories (chat routing must never offer chats to them).
 */
final class UpdateAgent
{
    public function __construct(
        private readonly AuthModeGuard $mode,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array{max_concurrent_chats?: int, is_active?: bool, is_agent?: bool}  $attributes  validated, partial
     *
     * @throws ApiProblemException
     * @throws ValidationException
     */
    public function handle(User $target, array $attributes, User $actor): User
    {
        if (array_key_exists('is_active', $attributes) || array_key_exists('is_agent', $attributes)) {
            $this->mode->requireManageable();
        }

        if (($attributes['is_active'] ?? true) === false && $target->is($actor)) {
            throw ApiProblemException::conflict('cannot_deactivate_self', __('You cannot deactivate your own account.'));
        }

        if (($attributes['is_agent'] ?? true) === false && $target->role !== UserRole::Admin) {
            throw ValidationException::withMessages(['is_agent' => [__('Agents always take chats. Deactivate the account instead.')]]);
        }

        $target->forceFill($attributes);

        if ($target->isDirty()) {
            $changes = $target->getDirty();

            DB::transaction(function () use ($target): void {
                $target->save();

                if ($target->wasChanged('is_agent') && ! $target->is_agent) {
                    DB::table('category_user')->where('user_id', $target->id)->delete();
                }
            });

            $this->audit->record('agent.updated', $target, $changes, $actor);
        }

        return $target->refresh();
    }
}
