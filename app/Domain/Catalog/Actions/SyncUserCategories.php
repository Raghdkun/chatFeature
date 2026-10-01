<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\Category;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\DB;

/**
 * Replaces the set of categories a staff member serves. Callers validate the ULIDs first
 * (UserCategories::unknown()); anything unknown is ignored here.
 */
final class SyncUserCategories
{
    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  list<string>  $categoryUlids
     * @return list<string> the ULIDs that are stored now
     */
    public function handle(User $user, array $categoryUlids, ?User $actor = null, string $action = 'user.categories_updated'): array
    {
        $categoryUlids = array_values(array_unique($categoryUlids));
        $ids = array_map('intval', Category::query()->whereIn('ulid', $categoryUlids)->pluck('id')->all());

        DeadlockRetry::transaction(function () use ($user, $ids): void {
            // A plain read (no locks), then exact-key deletes and inserts: `delete ... where user_id = ? and category_id not in (...)`
            // scans a range of the `user_id` index and its gap locks make two agents saving at the same moment deadlock (1213).
            $current = array_map('intval', DB::table('category_user')->where('user_id', $user->id)->pluck('category_id')->all());

            foreach (array_diff($current, $ids) as $categoryId) {
                DB::table('category_user')->where('category_id', $categoryId)->where('user_id', $user->id)->delete();
            }

            $now = now();

            // An upsert, not a plain insert: a double submit must not collide in the `(category_id, user_id)` key.
            $rows = array_map(
                fn (int $id): array => ['category_id' => $id, 'user_id' => $user->id, 'created_at' => $now, 'updated_at' => $now],
                array_values(array_diff($ids, $current)),
            );

            if ($rows !== []) {
                DB::table('category_user')->upsert($rows, ['category_id', 'user_id'], ['updated_at']);
            }
        });

        $this->audit->record($action, $user, ['category_ulids' => $categoryUlids], $actor ?? $user);

        return $categoryUlids;
    }
}
