<?php

namespace App\Domain\Catalog\Support;

use App\Models\Category;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Read side of "which categories does a staff member serve" (the `category_user` pivot).
 */
final class UserCategories
{
    /**
     * ULIDs of the live categories one user serves, in category order.
     *
     * @return list<string>
     */
    public function ulidsFor(User $user): array
    {
        return $this->ulidsForUsers([$user->id])[$user->id] ?? [];
    }

    /**
     * ULIDs of the live categories each of the given users serves.
     *
     * @param  list<int>  $userIds
     * @return array<int, list<string>> user id => category ULIDs
     */
    public function ulidsForUsers(array $userIds): array
    {
        if ($userIds === []) {
            return [];
        }

        $rows = DB::table('category_user')
            ->join('categories', 'categories.id', '=', 'category_user.category_id')
            ->whereIn('category_user.user_id', $userIds)
            ->whereNull('categories.deleted_at')
            ->orderBy('categories.sort_order')
            ->orderBy('categories.id')
            ->get(['category_user.user_id', 'categories.ulid']);

        $map = [];

        foreach ($rows as $row) {
            $map[(int) $row->user_id][] = (string) $row->ulid;
        }

        return $map;
    }

    /**
     * ULIDs among `$ulids` that do not name a live category (optionally: an active one).
     *
     * @param  list<string>  $ulids
     * @return list<string>
     */
    public function unknown(array $ulids, bool $onlyActive): array
    {
        $found = Category::query()
            ->when($onlyActive, fn ($query) => $query->where('is_active', true))
            ->whereIn('ulid', $ulids)
            ->pluck('ulid')
            ->all();

        return array_values(array_diff($ulids, $found));
    }
}
