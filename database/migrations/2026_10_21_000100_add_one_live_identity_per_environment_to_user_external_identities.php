<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * One LIVE (not deactivated) portal identity per local user and environment, enforced by the database.
 *
 * MySQL has no partial unique index, so a virtual column carries the environment id while the identity is live and is
 * NULL once it is deactivated; the unique key `(user_id, live_environment_id)` then ignores deactivated rows (NULLs never
 * collide). Without it two portal accounts that share an email could both be linked to one local user, and the role
 * resolver could not tell which of them just signed in.
 *
 * Rows that already violate the rule are repaired first: the most recently verified identity stays live, the others
 * are deactivated (they can no longer sign in; the person's sessions on them end on their next request).
 */
return new class extends Migration
{
    public function up(): void
    {
        $duplicates = DB::table('user_external_identities')
            ->select('user_id', 'auth_environment_id')
            ->whereNull('deactivated_at')
            ->groupBy('user_id', 'auth_environment_id')
            ->havingRaw('count(*) > 1')
            ->get();

        foreach ($duplicates as $group) {
            $ids = DB::table('user_external_identities')
                ->where('user_id', $group->user_id)
                ->where('auth_environment_id', $group->auth_environment_id)
                ->whereNull('deactivated_at')
                ->orderByDesc('last_verified_at')
                ->orderByDesc('id')
                ->pluck('id');

            DB::table('user_external_identities')
                ->whereIn('id', $ids->slice(1)->all())
                ->update(['active' => false, 'deactivated_at' => now()]);
        }

        Schema::table('user_external_identities', function (Blueprint $table) {
            $table->unsignedBigInteger('live_environment_id')->nullable()->virtualAs('CASE WHEN deactivated_at IS NULL THEN auth_environment_id END');
            $table->unique(['user_id', 'live_environment_id'], 'user_external_identities_one_live_per_env_unique');
        });
    }

    public function down(): void
    {
        Schema::table('user_external_identities', function (Blueprint $table) {
            $table->dropUnique('user_external_identities_one_live_per_env_unique');
            $table->dropColumn('live_environment_id');
        });
    }
};
