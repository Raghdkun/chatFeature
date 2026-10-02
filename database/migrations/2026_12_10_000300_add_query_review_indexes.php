<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Indexes found missing by the P7 query review (docs/runbook.md "Query review": EXPLAIN of every hot path on 50 000 conversations /
 * 500 000 messages / 30 000 visitors). The hot paths of the chat (queue, lists, offers, claim, `after_seq`, presence, availability) were
 * already served by indexes; what was left are the maintenance statements that scanned a whole table:
 *
 * - `conversations (status, closed_at)`: the retention prune (`chat:prune-conversations`) asks for closed / missed conversations older than
 *   N days; without it "nothing to delete yet" is a full scan every run.
 * - `visitors (verified, created_at)`: the daily visitor prune (anonymous visitors without a session or a conversation).
 * - `visitor_sessions (revoked_at)`: the daily session prune ORs `expires_at` with `revoked_at`; with an index on each the optimiser
 *   merges them instead of scanning the table.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->index(['status', 'closed_at'], 'conversations_retention_index');
        });

        Schema::table('visitors', function (Blueprint $table) {
            $table->index(['verified', 'created_at'], 'visitors_prune_index');
        });

        Schema::table('visitor_sessions', function (Blueprint $table) {
            $table->index('revoked_at', 'visitor_sessions_revoked_at_index');
        });
    }

    public function down(): void
    {
        Schema::table('visitor_sessions', function (Blueprint $table) {
            $table->dropIndex('visitor_sessions_revoked_at_index');
        });

        Schema::table('visitors', function (Blueprint $table) {
            $table->dropIndex('visitors_prune_index');
        });

        Schema::table('conversations', function (Blueprint $table) {
            $table->dropIndex('conversations_retention_index');
        });
    }
};
