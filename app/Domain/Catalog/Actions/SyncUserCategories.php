<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\Category;
use App\Models\User;
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
        $ids = Category::query()->whereIn('ulid', $categoryUlids)->pluck('id')->all();

        DB::transaction(function () use ($user, $ids): void {
            DB::table('category_user')->where('user_id', $user->id)->whereNotIn('category_id', $ids)->delete();

            $existing = DB::table('category_user')->where('user_id', $user->id)->pluck('category_id')->all();
            $now = now();

            $rows = array_map(
                fn (int $id): array => ['category_id' => $id, 'user_id' => $user->id, 'created_at' => $now, 'updated_at' => $now],
                array_values(array_diff($ids, $existing)),
            );

            if ($rows !== []) {
                DB::table('category_user')->insert($rows);
            }
        });

        $this->audit->record($action, $user, ['category_ulids' => $categoryUlids], $actor ?? $user);

        return $categoryUlids;
    }
}
