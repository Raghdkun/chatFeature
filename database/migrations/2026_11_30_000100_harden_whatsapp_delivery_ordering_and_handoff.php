<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * What the P5/P6 fix round needs on top of the WhatsApp schema:
 *
 * - `wa_messages.announced_at` (C1): set once the realtime events of a stored inbound message went out (after media and linking), so a
 *   retried delivery of a message that is stored but was not finished completes it, while a plain repeat of a finished one stays a
 *   no-op. Existing rows count as finished.
 * - `wa_webhook_deliveries.body` + `replays` (C4): the raw (signed) body is kept on the ledger row until the delivery is processed, so a
 *   lost queue job or an exhausted delivery can be replayed by `whatsapp:replay-deliveries`; `replays` is the retry budget used.
 * - `whatsapp_sessions.last_event_ms` (S3): the newest session event time applied (epoch milliseconds, from the signed envelope), kept in
 *   the database so a captured older session event replayed later (a fresh cache, a pruned ledger row) is still dropped.
 * - `wa_handoff_tickets.network_hash` (S5): the client network the code was asked from, for the cap on live codes per network and widget.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('wa_messages', function (Blueprint $table) {
            $table->timestamp('announced_at')->nullable()->after('error');
        });

        DB::table('wa_messages')->whereNull('announced_at')->update(['announced_at' => DB::raw('created_at')]);

        Schema::table('wa_webhook_deliveries', function (Blueprint $table) {
            $table->mediumText('body')->nullable()->after('error');
            $table->unsignedSmallInteger('replays')->default(0)->after('body');
            $table->index(['outcome', 'received_at']);
        });

        Schema::table('whatsapp_sessions', function (Blueprint $table) {
            $table->unsignedBigInteger('last_event_ms')->nullable()->after('ready_at');
        });

        Schema::table('wa_handoff_tickets', function (Blueprint $table) {
            $table->char('network_hash', 64)->nullable()->after('session_id');
            $table->index(['widget_id', 'network_hash']);
        });
    }

    public function down(): void
    {
        Schema::table('wa_handoff_tickets', function (Blueprint $table) {
            // On MySQL the composite index took over as the index of the `widget_id` foreign key: give the key its own back first.
            $table->index('widget_id');
            $table->dropIndex(['widget_id', 'network_hash']);
            $table->dropColumn('network_hash');
        });

        Schema::table('whatsapp_sessions', function (Blueprint $table) {
            $table->dropColumn('last_event_ms');
        });

        Schema::table('wa_webhook_deliveries', function (Blueprint $table) {
            $table->dropIndex(['outcome', 'received_at']);
            $table->dropColumn(['body', 'replays']);
        });

        Schema::table('wa_messages', function (Blueprint $table) {
            $table->dropColumn('announced_at');
        });
    }
};
