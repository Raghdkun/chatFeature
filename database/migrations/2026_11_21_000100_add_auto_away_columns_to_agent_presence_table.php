<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * P5: `last_visible_at` (the last heartbeat that reported a visible dashboard tab: auto-away counts from it) and `effective_status`
 * (the status clients were last told, so a change is announced once; the sweep walks the rows announced as reachable; null = never
 * announced, read as the status the row implies). `status` stays what the agent chose, `is_manual` whether they pinned it. In Redis mode
 * the row is a mirror written only when the effective status changes.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('agent_presence', function (Blueprint $table) {
            $table->timestamp('last_visible_at')->nullable()->after('last_heartbeat_at');
            $table->string('effective_status', 16)->nullable()->after('last_visible_at');

            $table->index('effective_status');
        });

        // Rows written by P4: whoever was reachable at the time of the upgrade stays announced as such, everybody else as offline.
        DB::table('agent_presence')->update(['effective_status' => 'offline']);
        DB::table('agent_presence')
            ->where('status', '!=', 'offline')
            ->where('last_heartbeat_at', '>=', now()->subSeconds(90))
            ->update(['effective_status' => DB::raw('status')]);
    }

    public function down(): void
    {
        Schema::table('agent_presence', function (Blueprint $table) {
            $table->dropIndex(['effective_status']);
            $table->dropColumn(['last_visible_at', 'effective_status']);
        });
    }
};
