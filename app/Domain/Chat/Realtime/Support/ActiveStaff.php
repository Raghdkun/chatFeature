<?php

namespace App\Domain\Chat\Realtime\Support;

use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Who a realtime event may be addressed to at all: active accounts that still have chat access (admin and/or agent).
 * Channel authorisation is the real gate (it runs on every subscribe); filtering here stops a deactivated or demoted staff
 * member whose socket is still open from being sent visitor details after the fact.
 */
final class ActiveStaff
{
    /**
     * @return Builder<User>
     */
    public static function query(): Builder
    {
        return User::query()
            ->where('is_active', true)
            ->where(fn (Builder $roles) => $roles->where('is_admin', true)->orWhere('is_agent', true));
    }

    /**
     * Of these user ids, the ones that are active staff.
     *
     * @param  iterable<int>  $userIds
     * @return list<int>
     */
    public static function only(iterable $userIds): array
    {
        $ids = [];

        foreach ($userIds as $userId) {
            $ids[$userId] = $userId;
        }

        if ($ids === []) {
            return [];
        }

        return array_values(self::query()->whereIn('id', array_values($ids))->orderBy('id')->pluck('id')->map(fn ($id): int => (int) $id)->all());
    }
}
