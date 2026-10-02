<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The stale-socket cut-off (P7, docs/realtime.md "Cutting a socket off").
 *
 * - `realtime_grants`: which staff member was handed a signed subscription to which conversation channel (written when
 *   `POST /broadcasting/auth` authorises it, only for agents: an administrator's access follows the role). When a conversation's
 *   access changes (transfer, claim, assignment) the grants of that conversation are judged again and a member who lost it has
 *   their sockets closed.
 * - `socket_cutoffs`: tags still to be terminated at Reverb: a retry of a call that failed and the follow-up that closes the
 *   short window between "the authorisation was granted" and "the subscription frame arrived". Worked off by `chat:realtime-sweep`.
 * - `visitor_sessions.socket_authorized_at / sockets_cut_at`: a visitor session that was ever handed a signed subscription, and
 *   when its sockets were last closed, so the sweep can cut the ones whose token expired or was revoked.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('realtime_grants', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('conversation_id')->constrained('conversations')->cascadeOnDelete();
            $table->timestamp('granted_at');

            $table->unique(['user_id', 'conversation_id']);
            $table->index(['conversation_id']);
            $table->index('granted_at');
        });

        Schema::create('socket_cutoffs', function (Blueprint $table) {
            $table->id();
            $table->string('tag', 64);
            $table->string('reason', 40);
            $table->unsignedTinyInteger('attempts')->default(0);
            $table->timestamp('due_at');
            $table->timestamp('created_at')->nullable();

            $table->index('due_at');
        });

        Schema::table('visitor_sessions', function (Blueprint $table) {
            $table->timestamp('socket_authorized_at')->nullable();
            $table->timestamp('sockets_cut_at')->nullable();

            $table->index(['socket_authorized_at', 'sockets_cut_at'], 'visitor_sessions_socket_cut_index');
        });
    }

    public function down(): void
    {
        Schema::table('visitor_sessions', function (Blueprint $table) {
            $table->dropIndex('visitor_sessions_socket_cut_index');
            $table->dropColumn(['socket_authorized_at', 'sockets_cut_at']);
        });

        Schema::dropIfExists('socket_cutoffs');
        Schema::dropIfExists('realtime_grants');
    }
};
